import { describe, expect, it } from "vitest";

import { assistantMessagePreview, redactedAgentToolArguments, redactedAgentToolResult } from "./local-agent-visible-message.ts";

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
});
