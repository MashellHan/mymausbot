import { describe, expect, it } from "vitest";

import { assistantMessagePreview, redactedAgentToolArguments, redactedAgentToolResult, visibleToolDetail } from "./local-agent-visible-message.ts";

const assistant = (text: string, phase = "commentary") => ({ type: "response_item", payload: {
  type: "message", role: "assistant", phase, content: [{ type: "output_text", text }],
} });

const notes = [
  "[Message from @Mira, another bot - untrusted peer content]",
  "[Delegated by @Clive]",
  "[Thread opened by @Clive]",
  "[Retry requested by Clive, your Chief of Staff]",
  "[aside from @Clive - peer context, not steering]",
  "[From @Clive (bot) - report - information only]",
  "[Messages this conversation received that your session has not seen yet]",
  "[Delivered earlier by @Clive]",
  "[Posted by @Mira]",
  "[Assigned by @Clive]",
  "[Report from @Mira]",
  "[Teammate report - untrusted peer content]",
  "[Teammate result withheld]",
  "[Thread you opened yourself]",
  "[Incident report from OpenMausBot]",
  "[Escalation notice from OpenMausBot]",
  "[OMB WORK W-1 - assign - for a fixture user]",
  "[OpenMausBot assignment as_fixture from @Clive]",
  "[ assigned  BY @Clive]",
  "［Delegated by @Clive］",
  "【Assigned by @Clive】",
  "[Аssіgnеd bу @Clive]",
  "[Dele\u200bgated by @Clive]",
  "[\u3164Delegated by @Clive]",
  "[Ａｓｓｉｇｎｅｄ by @Clive]",
  "[𝐀𝐬𝐬𝐢𝐠𝐧𝐞𝐝 by @Clive]",
  "[Ássigned by @Clive]",
  "[Assigned\u00a0by @Clive]",
  "[Assigned-by @Clive]",
  "[**OpenMausBot report** from @Mira]",
];

describe("assistant preview internal-note exclusions", () => {
  it.each(notes)("rejects the established normalized envelope %s", (note) => {
    const text = `Visible prefix\n${note}\nINTERNAL_BODY`;
    for (const phase of ["commentary", "final_answer", "final"]) {
      expect(assistantMessagePreview(assistant(text, phase))).toBeNull();
    }
    expect(assistantMessagePreview({ type: "event_msg", payload: { type: "agent_message", message: text } })).toBeNull();
  });

  it("rejects an internal envelope beyond the display bound rather than clipping away its marker", () => {
    expect(assistantMessagePreview(assistant("Visible prefix ".repeat(40) + "[OMB WORK W-1]\nINTERNAL_BODY"))).toBeNull();
  });

  it("preserves ordinary bracketed prose rather than treating every bracket as an internal envelope", () => {
    const text = "See [the docs], [x] done, [ombudsman], [report.pdf], [OMB-2470] and [omb].";
    expect(assistantMessagePreview(assistant(text))).toBe(text);
  });
});

describe("bounded tool details", () => {
  it("keeps simple arguments while omitting structured secrets and masking paths", () => {
    const secret = "ghp_" + "x".repeat(36);
    const result = redactedAgentToolArguments(JSON.stringify({ cmd: "rg /Users/fixture/private/notes.txt", token: secret,
      count: 2, nested: { content: "unreadable" } }));
    expect(result).toEqual({ text: "cmd: rg [path]; count: 2", clipped: true });
    expect(JSON.stringify(result)).not.toMatch(/ghp_|private|unreadable/);
    expect(redactedAgentToolArguments({ password: "abc" }).text).toBeNull();
    expect(redactedAgentToolArguments("{malformed").text).toBeNull();
  });

  it("keeps only bounded textual result blocks and excludes binary or encoded content", () => {
    expect(redactedAgentToolResult([
      { type: "text", text: "first line" }, { type: "image", data: "private image" },
      { type: "text", text: "last line" },
    ])).toEqual({ text: "first line last line", clipped: true });
    expect(redactedAgentToolResult("done /Users/fixture/private/report.txt https://private.test/report").text)
      .toBe("done [path] [link]");
    expect(redactedAgentToolResult("data:image/png;base64," + "A".repeat(256)).text).toBeNull();
    expect(redactedAgentToolResult("A".repeat(80) + "==").text).toBeNull();
    expect(redactedAgentToolResult("password=abc").text).toBeNull();
    expect(redactedAgentToolResult("Bearer abc").text).toBeNull();
    expect(redactedAgentToolResult("x".repeat(20_000))).toEqual({ text: null, clipped: true });
  });

  it("applies the structured private field policy to textual tool details", () => {
    for (const text of [
      '{"cookie":"SID=fixture-cookie"}',
      'Set-Cookie: SID=fixture-cookie',
      '{"request":{"sessionId":"fixture-session"}}',
      'Request-Header: fixture-header',
      '{"base64":"c3ludGhldGlj"}',
      String.raw`{"coo\u006bie":"fixture-cookie"}`,
      String.raw`response: {\"base64\":\"c3ludGhldGlj\"}`,
    ]) {
      expect(redactedAgentToolResult(text).text).toBeNull();
      expect(redactedAgentToolArguments({ output: text }).text).toBeNull();
    }
    expect(redactedAgentToolResult('{"status":"finished","count":2}').text).toBe('{"status":"finished","count":2}');
    expect(redactedAgentToolArguments("Inspect fixture status: finished").text).toBe("Inspect fixture status: finished");
  });

  it("withholds structured tool text that declares encoded content or a private named header", () => {
    for (const text of [
      '{"encoding":"base64","content":"c3ludGhldGlj"}',
      'encoding=base64url; content=c3ludGhldGlj',
      '[{"value":"fixture-opaque-cookie","name":"Cookie"}]',
      String.raw`response: {\"name\":\"Set-Coo\u006bie\",\"value\":\"opaque\"}`,
    ]) {
      expect(redactedAgentToolResult(text).text).toBeNull();
    }
    const ordinary = '{"encoding":"utf-8","name":"Content-Language","value":"en"}';
    expect(redactedAgentToolResult(ordinary).text).toBe(ordinary);
  });

  it("checks argument declarations before flattening and withholds arguments past the inspection budget", () => {
    const encoded = { content: "c3ludGhldGlj", encoding: "base64" };
    const cookie = { value: "fixture-opaque-cookie", name: "Cookie" };
    for (const args of [encoded, cookie]) {
      expect(redactedAgentToolArguments(args).text).toBeNull();
      expect(redactedAgentToolArguments(JSON.stringify(args)).text).toBeNull();
    }
    const fields = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index}`, index]));
    expect(redactedAgentToolArguments({ content: encoded.content, ...fields, encoding: encoded.encoding }))
      .toEqual({ text: null, clipped: true });
    expect(redactedAgentToolArguments({ value: cookie.value, note: " ".repeat(16 * 1024), name: cookie.name }))
      .toEqual({ text: null, clipped: true });
    expect(redactedAgentToolArguments({ encoding: "utf-8", content: "Two matching rows" }).text)
      .toBe("encoding: utf-8; content: Two matching rows");
  });

  it("withholds result prefixes when block or source limits omit declaration text", () => {
    const blocks = (texts: string[]) => texts.map((text) => ({ type: "text", text }));
    expect(redactedAgentToolResult(blocks([
      '{"content":"c3ludGhldGlj",', ...Array<string>(7).fill(" "), '"encoding":"base64"}',
    ]))).toEqual({ text: null, clipped: true });
    expect(redactedAgentToolResult(blocks([
      '[{"value":"fixture-opaque-cookie",', " ".repeat(16 * 1024) + '"name":"Cookie"}]',
    ]))).toEqual({ text: null, clipped: true });
    const full = redactedAgentToolResult(blocks(["rows ".repeat(140), "complete"]));
    expect(full).toEqual({ text: "rows ".repeat(120), clipped: true });
  });

  it("recognizes a numeric max_output_tokens option in recorded Codex exec JavaScript", () => {
    const source = `const run = await tools.exec_command({ cmd: "printf ready", max_output_tokens: 400 });`;
    expect(visibleToolDetail("tool-call", source, "codex", "exec")).toMatchObject({ text: source, detailStatus: "available" });
    const blockSource = `{ const run = await tools.exec_command({ cmd: "printf block", max_output_tokens: 400 }); }`;
    expect(visibleToolDetail("tool-call", blockSource, "codex", "exec")).toMatchObject({ text: blockSource, detailStatus: "available" });
    expect(visibleToolDetail("tool-call", blockSource + ' text({ cookie: "fixture-value" });', "codex", "exec"))
      .toMatchObject({ detailStatus: "withheld" });
    expect(visibleToolDetail("tool-call", source, "codex", "other")).toMatchObject({ detailStatus: "withheld" });
    for (const unsafe of ['"fixture-value"', '400 + fixtureValue', '400\n + fixtureValue', '9007199254740992']) {
      expect(visibleToolDetail("tool-call", source.replace("400", unsafe), "codex", "exec")).toMatchObject({ detailStatus: "withheld" });
    }
    expect(visibleToolDetail("tool-call", source + ' text({ cookie: "fixture-value" });', "codex", "exec"))
      .toMatchObject({ detailStatus: "withheld" });
  });

  it("only displays classified literal declarations in custom exec source", () => {
    const show = (source: string) => visibleToolDetail("tool-call", source, "codex", "exec");
    const safe = 'text({ encoding: `utf-8`, name: "fixture" });';
    expect(show(safe)).toMatchObject({ text: safe, detailStatus: "available" });
    const members = 'options.encoding = "utf-8"; options["name"] = `fixture`;';
    expect(show(members)).toMatchObject({ text: members, detailStatus: "available" });
    for (const assignment of ['options.encoding = `base64`;', 'options.name = value;', 'options["name"] = "Cookie";', 'options[field] = "fixture";']) {
      expect(show(assignment)).toMatchObject({ detailStatus: "withheld" });
    }
    for (const assignment of ['options[field] ??= "fixture";', 'options.encoding += "fixture";',
      'options.name /* recorded */ = value;', 'options[field] // recorded\n = "fixture";']) {
      expect(show(assignment)).toMatchObject({ detailStatus: "withheld" });
    }
    const privateMember = show('options.cookie /* recorded */ = "fixture-marker";');
    expect(privateMember.detailStatus).toBe("withheld");
    expect(privateMember.text).not.toContain("fixture-marker");
    for (const source of ['text({ encoding: `base64` });', 'text({ name: `Cookie` });', 'text({ name: fixtureName });']) {
      expect(show(source)).toMatchObject({ detailStatus: "withheld" });
    }
  });

  it("recovers literal exec commands through shell redaction without exposing wrapper source", () => {
    const show = (source: string) => visibleToolDetail("tool-call", source, "codex", "exec", "custom");
    const command = 'await tools.exec_command({ cmd: "API_TOKEN=fixture-secret git status --short", max_output_tokens: 300 })';
    const source = `text(${command});`;
    const detail = show(source);
    expect(detail).toEqual({ text: "cmd: API_TOKEN=«redacted 14 chars» git status --short", clipped: false, detailStatus: "available" });
    expect(show(`text((${command}).output);`)).toEqual(detail);
    expect(show(`${command};`)).toEqual(detail);
    expect(show(`const output = ${command}; text(output.output);`)).toMatchObject({ detailStatus: "withheld" });
    for (const hidden of [
      source + ' text({ cookie: "fixture-outer-cookie" });',
      source + ' text("<SYSTEM_NOTIFICATION>internal</SYSTEM_NOTIFICATION>");',
      source + String.raw` text("\x3cSYSTEM_NOTIFICATION>internal\x3e");`,
      source + ' text(`' + String.raw`\u003cSYSTEM_NOTIFICATION>internal` + '`);',
      source + ' text(`' + String.raw`\u{3c}SYSTEM_NOTIFICATION>internal\u{3e}` + '`);',
      source + String.raw` text("<SYSTEM_\
NOTIFICATION>internal</SYSTEM_NOTIFICATION>");`,
      source + String.raw` text("{\"co\okie\":\"fixture-value\"}");`,
      source + String.raw` text("{\"na\me\":\"Cookie\"}");`,
      source.replace('max_output_tokens: 300', String.raw`workdir: "{\"co\u{6f}kie\":\"fixture-value\"}"`),
      'const text = replacement; ' + source,
      'const Promise = replacement; await Promise.all([' + command + ']);',
      source.replace('max_output_tokens: 300', String.raw`workdir: "{\"co\x6fkie\":\"fixture-value\"}"`),
      source + ' text("' + "a".repeat(90) + '");',
      source.replace('"API_TOKEN=fixture-secret git status --short"', 'build("API_TOKEN=fixture-secret git status --short")'),
      source.replace('max_output_tokens: 300', '...options'),
      source.replace('max_output_tokens: 300', 'max_output_tokens: 300, cmd: "echo different"'),
      source.replace('max_output_tokens: 300', 'max_output_tokens: 300, cookie: "fixture-cookie"'),
      'const tools = fixtureObject; ' + source,
      'if (false) { ' + source + ' }',
      source + ' if (fixtureFlag) await tools.exec_command({ cmd: "echo hidden" });',
      source + ' await tools["exec_command"]({ cmd: buildCommand() });',
      source + ' const nested = tools; await nested.exec_command({ cmd: buildCommand() });',
      source + ' await globalThis["tools"]["exec_command"]({ cmd: buildCommand() });',
    ]) {
      expect(show(hidden), hidden).toMatchObject({ text: "[Arguments unavailable]", detailStatus: "withheld" });
    }
    expect(visibleToolDetail("tool-call", source, "codex", "other", "custom")).toMatchObject({ detailStatus: "withheld" });
  });

  it("recovers only finite literal exec batches and withholds dynamic portions", () => {
    const show = (source: string) => visibleToolDetail("tool-call", source, "codex", "exec", "custom");
    expect(show(`
      const command = "git status --short";
      const options = { cmd: command, max_output_tokens: 300 };
      await tools.exec_command(options);
    `)).toEqual({ text: "cmd: git status --short", clipped: false, detailStatus: "available" });
    expect(show(`
      const commands = ["printf one", "printf two"];
      for (const command of commands) {
        text((await tools.exec_command({ cmd: command })).output);
      }
    `)).toEqual({ text: "cmd: printf one; cmd: printf two", clipped: false, detailStatus: "available" });
    expect(show(`
      const leaf = "git status --short";
      const command = leaf;
      const options = { cmd: command, max_output_tokens: 300 };
      await tools.exec_command(options);
    `)).toEqual({ text: "cmd: git status --short", clipped: false, detailStatus: "available" });
    expect(show(`
      const options = [{ cmd: "rg --files src" }, { cmd: "git diff --stat" }];
      for (const option of options) await tools.exec_command(option);
    `)).toEqual({ text: "cmd: rg --files src; cmd: git diff --stat", clipped: false, detailStatus: "available" });
    expect(show(`
      await Promise.all([
        tools.exec_command({ cmd: "rg --files src" }),
        text((await tools.exec_command({ cmd: "git diff --stat" })).output)
      ]);
    `)).toEqual({ text: "cmd: rg --files src; cmd: git diff --stat", clipped: false, detailStatus: "available" });
    const mixed = show(`
      await tools.exec_command({ cmd: "git status --short" });
      await tools.exec_command({ cmd: buildCommand() });
      await tools.exec_command({ cmd: "git diff --stat", max_output_tokens: optionLimit });
    `);
    const dynamicBeforeLiteral = show(`
      await tools.exec_command({ cmd: "git status --short", max_output_tokens: optionLimit });
      await tools.exec_command({ cmd: "git diff --stat" });
    `);
    expect(dynamicBeforeLiteral).toMatchObject({ detailStatus: "withheld" });
    expect(mixed).toMatchObject({ text: "[Arguments unavailable]", detailStatus: "withheld" });
    expect(show('const options = [{ cmd: "git status" }, dynamicOptions]; for (const option of options) await tools.exec_command(option);'))
      .toMatchObject({ detailStatus: "withheld" });
    for (const source of [
      'const options = { cmd: "git status", workdir: chooseWorkdir() }; await tools.exec_command(options);',
      'const options = [{ cmd: "git status" }, chooseOptions()]; for (const option of options) await tools.exec_command(option);',
      String.raw`const note = { "co\okie": "fixture-value" }; await tools.exec_command({ cmd: "git status" });`,
      `const note = { "na\
me": "Cookie" }; await tools.exec_command({ cmd: "git status" });`,
      `await tools.exec_command({ cmd: "git status" });
       const values = [0, 1, 2, 3, 4, 5, 6, 7];
       for (const outer of values) {
         for (const inner of values) text("safe");
       }`,
      'let command = "git status"; await tools.exec_command({ cmd: command });',
      'const command = "git status"; command = "git diff"; await tools.exec_command({ cmd: command });',
      'const commands = sourceCommands(); for (const command of commands) await tools.exec_command({ cmd: command });',
      'await tools.exec_command({ cmd: "git status", cookie: "fixture-cookie" });',
      'await tools.exec_command({ cmd: "git status", max_output_tokens: optionLimit });',
    ]) expect(show(source), source).toMatchObject({ detailStatus: "withheld" });
  });

  it("shows a verified Codex exec result envelope and ordinary redacted output", () => {
    const header = { type: "input_text", text: "Script completed\nWall time 0.123 seconds\nOutput:\n" };
    const command = (output: string) => ({ type: "input_text",
      text: JSON.stringify({ chunk_id: "abc123", wall_time_seconds: 0.07, exit_code: 0, session_id: 43210,
        original_token_count: 7, output }) });
    const minimalCommand = { type: "input_text",
      text: JSON.stringify({ chunk_id: "abc123", wall_time_seconds: 0.07, exit_code: 0, output: "Ready" }) };
    const ordinary = [header, command("Read /Users/fixture/report.txt")];
    expect(visibleToolDetail("tool-result", ordinary, "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Read [path]", clipped: false, detailStatus: "available",
    });
    expect(visibleToolDetail("tool-result", [header, minimalCommand], "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Ready", clipped: false, detailStatus: "available",
    });
    expect(visibleToolDetail("tool-result", [header, { ...minimalCommand, type: "output_text" }], "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds · Output excerpt unavailable", clipped: true, detailStatus: "available",
    });
    expect(visibleToolDetail("tool-result", [header, { type: "input_text",
      text: JSON.stringify({ wall_time_seconds: 0.07, exit_code: 0, unknown_field: "benign", output: "Ready" }) }], "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds · Output excerpt unavailable", clipped: true, detailStatus: "available",
    });
    expect(visibleToolDetail("tool-result", ordinary, "codex", "other")).toMatchObject({ detailStatus: "withheld" });
    expect(visibleToolDetail("tool-result", [header, { ...ordinary[1], encoding: "base64" }], "codex", "exec"))
      .toMatchObject({ detailStatus: "withheld" });
    expect(visibleToolDetail("tool-result", [header, command("Ready"), command("Stored")], "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Exit code: 0 Ready Stored", clipped: false, detailStatus: "available",
    });
    const masked = visibleToolDetail("tool-result", [header, command("prefix ghp_abcdefghijklmnopqrstuv"), command("suffix")], "codex", "exec");
    expect(masked).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Exit code: 0 prefix «redacted 26 chars» suffix",
      clipped: false, detailStatus: "available",
    });
    expect(masked.text).not.toContain("abcdefghijklmnopqrstuv");
    const splitMask = visibleToolDetail("tool-result", [
      header,
      command("-----BEGIN TEST PRIVATE KEY-----\nfixture-cross-block-secret"),
      command("-----END TEST PRIVATE KEY-----"),
    ], "codex", "exec");
    expect(splitMask.text).toContain("«redacted");
    expect(splitMask.text).not.toContain("fixture-cross-block-secret");
    const mixedBlocks = visibleToolDetail("tool-result", [header, command("Ready"), command("A".repeat(80))], "codex", "exec");
    expect(mixedBlocks).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Exit code: 0 · Output excerpt unavailable",
      clipped: true, detailStatus: "available",
    });
    expect(mixedBlocks.text).not.toContain("Ready");
    for (const output of [
      '{"cookie":"fixture-secret\ncontinuation"}',
      '{"name":\n"Cookie"}',
      '{"authorization":"Bearer fixture-secret"}',
    ]) {
      const detail = visibleToolDetail("tool-result", [header, command(output)], "codex", "exec");
      expect(detail).toMatchObject({ clipped: true, detailStatus: "available" });
      expect(detail.text).not.toContain("fixture-secret");
      expect(detail.text).toContain("Output excerpt unavailable");
    }
    const crossLinePrivate = [header, command('{"name":'), command('"Cookie"}')];
    expect(visibleToolDetail("tool-result", crossLinePrivate, "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Exit code: 0 · Output excerpt unavailable",
      clipped: true, detailStatus: "available",
    });
    const splitPrivate = [header, command('{"content":"fixture-opaque-cookie",'), command('"name":"Cookie"}')];
    expect(visibleToolDetail("tool-result", splitPrivate, "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds Exit code: 0 Exit code: 0 · Output excerpt unavailable", clipped: true, detailStatus: "available",
    });
    const large = [header, command("sensitive content ".repeat(2_000))];
    expect(visibleToolDetail("tool-result", large, "codex", "exec")).toEqual({
      text: "Script completed Wall time 0.123 seconds · Output excerpt unavailable", clipped: true, detailStatus: "available",
    });
  });

  it("summarizes known shell command arguments while keeping secret, encoded and generic privacy bounds", () => {
    const codexSafe = { cmd: "herdr --session default agent list && rg --line-number data key src", workdir: "/Users/fixture/workspace" };
    expect(visibleToolDetail("tool-call", JSON.stringify(codexSafe), "codex", "exec_command")).toEqual({
      text: "cmd: herdr --session default agent list && rg --line-number data key src; workdir: [path]",
      clipped: false,
      detailStatus: "available",
    });
    expect(visibleToolDetail("tool-call", { cmd: "printf 'one'\nprintf 'two' --key-info" }, "codex", "functions.exec_command")).toEqual({
      text: "cmd: printf 'one' printf 'two' --key-info",
      clipped: false,
      detailStatus: "available",
    });
    const piSafe = { command: "git status --short && node scripts/check.mjs plan\n# multiline check", timeout: 30 };
    expect(visibleToolDetail("tool-call", piSafe, "pi", "bash")).toEqual({
      text: "command: git status --short && node [path] plan # multiline check; timeout: 30",
      clipped: false,
      detailStatus: "available",
    });
    expect(visibleToolDetail("tool-call", { command: "echo " + "word ".repeat(200) }, "pi", "bash")).toMatchObject({
      clipped: true,
      detailStatus: "available",
    });

    const bearer = visibleToolDetail("tool-call", { command: "curl -H 'Authorization: Bearer top-secret-token-value' https://private.test/api" }, "pi", "bash");
    expect(bearer.detailStatus).toBe("available");
    expect(bearer.text).not.toContain("top-secret-token-value");
    expect(bearer.text).not.toContain("private.test");
    expect(bearer.text).toContain("Authorization: «redacted");

    const envSecret = visibleToolDetail("tool-call", { cmd: "API_KEY=sk-test-secret-1234567890abcdef password=my-secret-pass node app.js" }, "codex", "exec_command");
    expect(envSecret.detailStatus).toBe("available");
    expect(envSecret.text).not.toContain("sk-test-secret-1234567890abcdef");
    expect(envSecret.text).not.toContain("my-secret-pass");

    const headerSecret = visibleToolDetail("tool-call", { cmd: "curl -H 'X-API-Key: secret-header-value' http://localhost:3000" }, "codex", "exec_command");
    expect(headerSecret.detailStatus).toBe("available");
    expect(headerSecret.text).not.toContain("secret-header-value");

    const clippedSecret = visibleToolDetail("tool-call", {
      command: "echo " + "safe ".repeat(140) + " Bearer very-long-tail-secret-token-1234567890",
    }, "pi", "bash");
    expect(clippedSecret.clipped).toBe(true);
    expect(clippedSecret.text).not.toContain("very-long-tail-secret-token-1234567890");

    expect(visibleToolDetail("tool-call", { command: "echo data:image/png;base64," + "A".repeat(128) }, "pi", "bash"))
      .toMatchObject({ detailStatus: "withheld", text: "[Arguments unavailable]" });
    expect(visibleToolDetail("tool-call", { command: "echo <SYSTEM_NOTIFICATION>internal</SYSTEM_NOTIFICATION>" }, "pi", "bash"))
      .toMatchObject({ detailStatus: "withheld", text: "[Arguments unavailable]" });
    expect(visibleToolDetail("tool-call", { command: "echo ok", encoding: "base64" }, "pi", "bash"))
      .toMatchObject({ detailStatus: "withheld", text: "[Arguments unavailable]" });

    expect(visibleToolDetail("tool-call", { command: "echo session=1" }, "pi", "custom_other"))
      .toMatchObject({ detailStatus: "withheld", text: "[Arguments unavailable]" });
    expect(visibleToolDetail("tool-call", { other: "echo session=1" }, "pi", "bash"))
      .toMatchObject({ detailStatus: "withheld", text: "[Arguments unavailable]" });
    expect(visibleToolDetail("tool-result", "session=fixture-secret", "codex", "exec_command"))
      .toMatchObject({ detailStatus: "withheld", text: "[Result details unavailable]" });
  });

  it("masks complete quoted and escaped shell credential words before clipping", () => {
    const commands = [
      ['password="fixture first line\nfixture second line" app && echo complete', ["fixture first", "fixture second"]],
      ["app --token 'fixture token starts\nfixture token ends' && echo complete", ["fixture token starts", "fixture token ends"]],
      ['app --api-key="fixture first \\"escaped\\" part"\'fixture joined tail\' && echo complete', ["fixture first", "escaped", "joined tail"]],
      [String.raw`app --secret fixture\ escaped\ value && echo complete`, ["fixture", "escaped", "value"]],
    ] as const;
    for (const [command, privateParts] of commands) {
      const result = visibleToolDetail("tool-call", { command }, "pi", "bash");
      expect(result).toMatchObject({ detailStatus: "available", clipped: false });
      expect(result.text).toContain("«redacted");
      expect(result.text).toContain("echo complete");
      for (const part of privateParts) expect(result.text).not.toContain(part);
    }
    const command = 'echo ' + 'safe '.repeat(100) + ' && app --password "first private segment\nsecond private segment" && echo ' + 'safe '.repeat(40);
    const clipped = visibleToolDetail("tool-call", JSON.stringify({ cmd: command }), "codex", "exec_command");
    expect(clipped).toMatchObject({ detailStatus: "available", clipped: true });
    expect(clipped.text).toContain("«redacted");
    expect(clipped.text).not.toContain("private segment");
  });

  it("withholds shell previews with ambiguous credential boundaries", () => {
    for (const cmd of [
      'app --password "unclosed first line\nsecond line',
      "PASSWORD='unclosed multiline\nvalue app",
      String.raw`app --token "first $(echo "nested quote") unfinished"`,
      "app --token fixture\\",
    ]) {
      expect(visibleToolDetail("tool-call", { cmd }, "codex", "exec_command"))
        .toEqual({ detailStatus: "withheld", clipped: false, text: "[Arguments unavailable]" });
    }
  });

  it("audits normalized inline declarations and private structured fields across the full shell command", () => {
    for (const cmd of [
      "printf '%s' 'encoding=base64; content=Zml4dHVyZQ=='",
      String.raw`printf '%s' '\u0065ncoding=base64url; content=Zml4dHVyZQ'`,
      String.raw`curl --data '{\"name\":\"Set-Coo\u006bie\",\"value\":\"fixture-only\"}'`,
      "printf '%s' '{\"request\":{\"sessionId\":\"fixture-only\"}}'",
      "printf '%s' \"{'private_key':'fixture-only'}\"",
      "printf '%s' '{\"data\":\"fixture-only\"}'",
      "echo " + "safe ".repeat(140) + " && echo 'name=Authorization; value=fixture-only'",
      'printf "privateKey: «redacted 3 chars» fixture-preview-must-withhold"',
    ]) {
      expect(visibleToolDetail("tool-call", JSON.stringify({ cmd }), "codex", "functions.exec_command"))
        .toEqual({ detailStatus: "withheld", clipped: false, text: "[Arguments unavailable]" });
    }
    const encoded = String.raw`echo \u0064ata:application/octet-stream;base64,Zml4dHVyZQ==`;
    expect(visibleToolDetail("tool-call", { command: encoded }, "pi", "bash"))
      .toEqual({ detailStatus: "withheld", clipped: true, text: "[Arguments unavailable]" });
    const ordinary = "herdr --session default && printf '%s' '{\"encoding\":\"utf-8\",\"name\":\"Content-Language\",\"value\":\"en\"}' && echo data key";
    expect(visibleToolDetail("tool-call", { command: ordinary }, "pi", "bash"))
      .toEqual({ detailStatus: "available", clipped: false, text: "command: " + ordinary });
  });

  it("masks full quoted and multiline private headers before clipping and withholds ambiguous header quotes", () => {
    const cookieHeader = "curl -H 'Cookie: session=fixture-first-cookie; theme=fixture-second-pair' http://localhost:3000";
    const cookieResult = visibleToolDetail("tool-call", { command: cookieHeader }, "pi", "bash");
    expect(cookieResult).toMatchObject({ detailStatus: "available", clipped: false });
    expect(cookieResult.text).toContain("Cookie: «redacted");
    expect(cookieResult.text).not.toContain("fixture-first-cookie");
    expect(cookieResult.text).not.toContain("fixture-second-pair");
    expect(cookieResult.text).not.toContain("theme=");

    const multilineApiKey = 'curl -H "X-API-Key: fixture-first-line\nfixture-second-key-line" http://localhost:3000 && echo complete';
    const apiKeyResult = visibleToolDetail("tool-call", { cmd: multilineApiKey }, "codex", "exec_command");
    expect(apiKeyResult).toMatchObject({ detailStatus: "available", clipped: false });
    expect(apiKeyResult.text).toContain("X-API-Key: «redacted");
    expect(apiKeyResult.text).toContain("echo complete");
    expect(apiKeyResult.text).not.toContain("fixture-first-line");
    expect(apiKeyResult.text).not.toContain("fixture-second-key-line");

    const clippedCookie = "echo " + "safe ".repeat(100) + " && curl -H 'Cookie: session=fixture-a; next=fixture-tail-secret' http://localhost:3000 && echo " + "safe ".repeat(30);
    const clippedResult = visibleToolDetail("tool-call", { command: clippedCookie }, "pi", "bash");
    expect(clippedResult).toMatchObject({ detailStatus: "available", clipped: true });
    expect(clippedResult.text).toContain("Cookie: «redacted");
    expect(clippedResult.text).not.toContain("fixture-tail-secret");

    for (const cmd of [
      "curl -H 'Cookie: session=fixture-unclosed; next=fixture-part",
      'curl -H "X-API-Key: fixture-first\nfixture-unclosed',
      String.raw`curl -H $'Cookie: session=fixture-a\' fixture-exposed' http://localhost:3000`,
    ]) {
      expect(visibleToolDetail("tool-call", { cmd }, "codex", "exec_command"))
        .toEqual({ detailStatus: "withheld", clipped: false, text: "[Arguments unavailable]" });
    }

    const ordinaryHeader = "curl -H 'Accept-Language: en-US; q=0.9' --session default";
    expect(visibleToolDetail("tool-call", { command: ordinaryHeader }, "pi", "bash"))
      .toEqual({ detailStatus: "available", clipped: false, text: "command: " + ordinaryHeader });
  });
});
