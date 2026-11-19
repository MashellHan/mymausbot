// Two real servers on this machine: one stands in for the person's computer, the other for a server that is theirs alone
// (as My Cloud is). Only each provider's planning is scripted. Nothing outside this machine is asked.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { linkedAddress } from "../electron/bot-link-address.mjs";
import { readHandoffs } from "./testing/handoff-rows.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

function place(fixture: Fixture) {
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: unknown[] }> = {};
  const api = async (method: string, path: string, body?: unknown, options: { status?: number; token?: string } = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(options.status ?? 200);
    return result;
  };
  return {
    url, dataDir, api,
    cli: (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>,
    plan(botId: string, ...turns: unknown[]) { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); },
    providerTurns: (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    messages: async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[],
  };
}

it("a bot on the computer and a bot on the person's own server hand each other work and get the result back", async () => {
  const fixtures = [await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }),
    await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true })];
  const computer = place(fixtures[0]!), home = place(fixtures[1]!);
  try {
    expect(await computer.api("GET", "/api/bot-link")).toEqual({ on: false });
    expect(existsSync(join(computer.dataDir, "bot-link.json"))).toBe(false);

    const writer = (await computer.cli("new-bot", "--name", "Writer")).bot;
    const atlas = (await home.cli("new-bot", "--name", "Atlas")).bot;

    // Pairing is the owner's: the app does it over the person's own sign-in there. The computer's own page is not one.
    await home.api("POST", "/api/bot-link/pair", { computer: { id: "computer", name: "Sam's Mac" }, name: "My server" }, { status: 403 });
    const pairing = await home.api("POST", "/api/auth/pairing", { label: "The person's app", scopes: ["admin", "client"] });
    const owner = (await home.api("POST", "/api/auth/pair", { code: pairing.code })).token as string;
    const thisComputer = { id: (await computer.api("GET", "/.well-known/openmausbot/environment")).environmentId as string, name: "Sam's Mac" };
    const paired = await home.api("POST", "/api/bot-link/pair", { computer: thisComputer, name: "My server" }, { token: owner });
    await computer.api("PUT", "/api/bot-link", { on: true, origin: home.url, token: paired.token, name: "Sam's Mac", cloud: paired.place });
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")), { timeout: 15_000 }).toMatchObject({ on: true, role: "dialer", online: true, peer: { name: "My server" } });
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")).bots, { timeout: 15_000 }).toBeGreaterThan(0);

    // The link's own sign-in opens the link and nothing else of the person's server.
    await home.api("GET", "/api/bots?messages=0", undefined, { token: paired.token, status: 403 });
    await home.api("GET", "/api/auth/session", undefined, { token: paired.token, status: 403 });
    // The standing exchange is held open by design: a backup of the linked server does not wait for it to end.
    // (This fixture's sign-in storage sits inside its data folder, which the backup itself then refuses: that check runs
    // only once the "wait for requests to finish" gate has let the backup through.)
    const backup = await fetch(`${home.url}/api/workspace-backup/export`, { method: "POST", headers: { "content-type": "application/json", origin: home.url, authorization: `Bearer ${owner}` },
      body: JSON.stringify({ password: "correct horse battery staple" }), signal: AbortSignal.timeout(20_000) });
    const backedUp = JSON.stringify(await backup.json());
    expect(backup.status, backedUp).not.toBe(409);
    expect(backedUp).not.toMatch(/Wait for bot turns/);
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")).online, { timeout: 15_000 }).toBe(true);

    // The server's bot is a record on the computer, found by its address there and nowhere else: not listed, not saved,
    // and it takes no turn on the computer.
    const rows = (await computer.api("GET", "/api/bot-link/bots")).bots as any[];
    const standIn = rows.find((row) => row.name === "Atlas");
    expect(standIn).toMatchObject({ botId: atlas.id, home: { name: "My server", kind: "cloud", key: expect.stringMatching(/^[0-9a-f]{8}$/u), online: true }, threadId: expect.any(String) });
    // The address is the one the app's main process works out for the sidebar's row of the same bot.
    expect(standIn.id).toBe(linkedAddress(paired.place.id, atlas.id));
    expect(standIn.id).toMatch(/^link-[0-9a-f]{8}-/);
    expect(JSON.stringify(await computer.api("GET", `/api/bots/${standIn.id}`))).toContain("\"Atlas\"");
    expect((await computer.api("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.id === standIn.id)).toBe(false);
    expect(readFileSync(join(computer.dataDir, "bots.json"), "utf8")).not.toContain(standIn.id);
    const direct = await fetch(`${computer.url}/api/bots/${standIn.id}/messages`, { method: "POST", headers: { "content-type": "application/json", origin: computer.url }, body: JSON.stringify({ text: "Are you here?" }) });
    const refused = JSON.stringify(await direct.json());
    expect(direct.status, refused).toBeGreaterThanOrEqual(400);
    expect(refused).toContain("lives on My server");
    await home.api("GET", "/api/bot-link/bots", undefined, { token: owner, status: 403 });

    // A stand-in is read-only on the computer. Every route that changes a bot is found in the server's own source and
    // asked for the stand-in, with each changing method: each answers where the bot lives, and nothing on the computer changes.
    expect(JSON.stringify(await computer.api("GET", `/api/bots/${standIn.id}`))).not.toContain("\"home\"");
    const source = [join(import.meta.dirname, "index.ts"), ...readdirSync(join(import.meta.dirname, "routes")).filter((name) => name.endsWith(".ts") && !name.includes(".test.")).map((name) => join(import.meta.dirname, "routes", name))]
      .map((file) => readFileSync(file, "utf8")).join("\n");
    const botRoutes = new Set([""]);
    for (const found of source.matchAll(/\\\/api\\\/bots\\\/\([^)]*\)((?:\\\/[a-z][\w-]*)*)/gu)) botRoutes.add(found[1]!.replaceAll("\\/", "/"));
    for (const found of source.matchAll(/["`]\/api\/bots\/\$\{[^}]*\}((?:\/[a-z][\w-]*)*)/gu)) botRoutes.add(found[1]!);
    expect(botRoutes.size, [...botRoutes].join(" ")).toBeGreaterThan(15);
    const before = { bots: readFileSync(join(computer.dataDir, "bots.json"), "utf8"), groups: existsSync(join(computer.dataDir, "groups.json")) ? readFileSync(join(computer.dataDir, "groups.json"), "utf8") : "", list: JSON.stringify((await computer.api("GET", "/api/bots?messages=0")).bots.map((bot: any) => [bot.id, bot.chiefOfStaff ?? false, bot.tasks?.length ?? 0])) };
    const asked = async (method: string, path: string, body: unknown) => {
      const response = await fetch(`${computer.url}${path}`, { method, headers: { "content-type": "application/json", origin: computer.url }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, text: await response.text() };
    };
    for (const route of botRoutes) for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const answer = await asked(method, `/api/bots/${standIn.id}${route}`, { chiefOfStaff: true, name: "Renamed", title: "New thread", text: "hello" });
      expect([answer.status, answer.text], `${method} /api/bots/<stand-in>${route}`).toEqual([409, expect.stringContaining("lives on My server")]);
    }
    // Named in a body: no automation of its own, with the same plain reason. (A room member it may be: see below.)
    for (const [path, body] of [["/api/routines", { name: "Daily", prompt: "Count the orders.", botId: standIn.id, schedule: { kind: "daily", time: "09:00" } }]] as const) {
      const answer = await asked("POST", path, body);
      expect(answer.status, `${path}: ${answer.text}`).toBeGreaterThanOrEqual(400);
      expect(answer.text, path).toContain("lives on My server");
    }
    expect((await asked("POST", "/api/webhooks", { name: "Orders", botId: standIn.id, prompt: "Read the order." })).status).toBeGreaterThanOrEqual(400);
    expect((await computer.api("GET", "/api/routines")).routines.some((routine: any) => routine.botId === standIn.id)).toBe(false);
    expect(readFileSync(join(computer.dataDir, "bots.json"), "utf8")).toBe(before.bots);
    expect(existsSync(join(computer.dataDir, "groups.json")) ? readFileSync(join(computer.dataDir, "groups.json"), "utf8") : "").toBe(before.groups);
    expect(JSON.stringify((await computer.api("GET", "/api/bots?messages=0")).bots.map((bot: any) => [bot.id, bot.chiefOfStaff ?? false, bot.tasks?.length ?? 0]))).toBe(before.list);
    expect(JSON.stringify(await computer.api("GET", `/api/bots/${standIn.id}`))).toContain("\"Atlas\"");

    // The computer's bot hands work to the server's bot by name, and is resumed with its result.
    home.plan(atlas.id, { reply: "Atlas counted 42 orders." });
    computer.plan(writer.id,
      { steps: [{ tool: "list_bots", arguments: {} }, { tool: "coordinate_bots", arguments: { bot_ids: ["Atlas"], request_key: "count", message: "Count this week's orders." } }], reply: "Asked Atlas." },
      { reply: "Atlas says 42." });
    await computer.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas for this week's order count.");
    await expect.poll(() => home.providerTurns().find((turn) => turn.botId === atlas.id), { timeout: 30_000 }).toBeTruthy();
    expect((await computer.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => (await computer.messages(writer.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /42 orders/.test(message.tool?.output ?? "")), { timeout: 20_000 }).toBe(true);
    const shown = await computer.messages(writer.activeTaskId);
    expect(shown.find((message) => message.roomRequest?.phase === "result").tool.name).toContain("Atlas (My server)");
    expect(shown.filter((message) => message.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Atlas says 42." });
    expect(home.providerTurns().filter((turn) => turn.botId === atlas.id)).toHaveLength(1);
    const there = (await home.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === atlas.id);
    const work = there.tasks.find((task: any) => /Writer/.test(task.title ?? ""));
    expect(work, JSON.stringify(there.tasks)).toBeTruthy();
    const worked = await home.messages(work.threadId);
    expect(worked.some((message) => /Count this week's orders\./.test(message.text ?? ""))).toBe(true);
    expect(worked.some((message) => message.text === "Atlas counted 42 orders.")).toBe(true);

    // A file goes with the work into the receiving conversation's own inbox, and one the teammate attaches comes back.
    const desk = join(computer.dataDir, "task-workspaces", writer.id, writer.activeTaskId), bench = join(home.dataDir, "task-workspaces", atlas.id, work.threadId);
    mkdirSync(desk, { recursive: true }); mkdirSync(bench, { recursive: true });
    writeFileSync(join(desk, "orders.csv"), "id,total\n1,20\n2,22\n");
    writeFileSync(join(bench, "totals.txt"), "42 in all\n");
    const under = (root: string, name: string): string[] => existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((entry) => entry.endsWith(name) && /(^|[\\/])inbox[\\/]/.test(entry)) : [];
    home.plan(atlas.id, { steps: [{ tool: "attach_file", arguments: { path: join(bench, "totals.txt") } }], reply: "Atlas totalled the export." });
    computer.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: ["Atlas"], request_key: "export", message: "Total this export.", files: [join(desk, "orders.csv")] } }], reply: "Sent Atlas the export." },
      { reply: "Atlas totalled it." });
    await computer.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Send Atlas the export to total.");
    await expect.poll(() => under(bench, "orders.csv").length, { timeout: 30_000 }).toBe(1);
    expect(readFileSync(join(bench, under(bench, "orders.csv")[0]!), "utf8")).toBe("id,total\n1,20\n2,22\n");
    await expect.poll(() => under(desk, "totals.txt").length, { timeout: 30_000 }).toBe(1);
    expect(readFileSync(join(desk, under(desk, "totals.txt")[0]!), "utf8")).toBe("42 in all\n");
    expect((await computer.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const withFiles = await computer.messages(writer.activeTaskId);
    expect(withFiles.some((message) => message.attachments?.some((file: any) => file.name === "orders.csv"))).toBe(true);
    expect(withFiles.some((message) => message.roomRequest?.phase === "result" && message.attachments?.some((file: any) => file.name === "totals.txt"))).toBe(true);

    // And the other way, over the same link.
    computer.plan(writer.id, { reply: "Writer drafted the summary." });
    home.plan(atlas.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: ["Writer"], request_key: "draft", message: "Draft the weekly summary." } }], reply: "Asked Writer." },
      { reply: "Writer drafted it." });
    await home.cli("send", "--bot", atlas.id, "--task", atlas.activeTaskId, "--text", "Have Writer draft the weekly summary.");
    await expect.poll(async () => (await home.messages(atlas.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /drafted the summary/.test(message.tool?.output ?? "")), { timeout: 40_000 }).toBe(true);
    expect((await home.cli("wait", "--bot", atlas.id, "--task", atlas.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect((await home.messages(atlas.activeTaskId)).filter((message) => message.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Writer drafted it." });

    // From a room: the other place's bot is in no room here, so it gets the work directly and its result comes back to the room.
    const editor = (await computer.cli("new-bot", "--name", "Editor")).bot;
    const room = (await computer.cli("new-channel", "--name", "Newsroom", "--members", `${writer.id},${editor.id}`)).channel;
    home.plan(atlas.id, { reply: "Atlas checked: 3 returns." });
    computer.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: ["Atlas"], request_key: "returns", message: "Count this week's returns." } }], reply: "Asked Atlas about returns." },
      { reply: "Atlas counts 3 returns." });
    await computer.cli("send-channel", "--channel", room.id, "--text", "@Writer ask Atlas how many returns we had.");
    await expect.poll(async () => (await computer.messages(room.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /3 returns/.test(message.tool?.output ?? "")), { timeout: 40_000 }).toBe(true);
    expect(await computer.cli("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const said = await computer.messages(room.activeTaskId);
    expect(said.some((message) => message.kind === "text" && message.text === "Atlas counts 3 returns.")).toBe(true);
    expect(said.find((message) => message.roomRequest?.phase === "result").tool.name).toContain("Atlas (My server)");

    // A room on the computer with a member from each place. The server's bot is mentioned: its turn runs on the server,
    // its answer is its own line in the room, once, and the member it names in that answer takes its turn after it.
    const made = (await computer.api("POST", "/api/groups", { name: "Launch", memberIds: [writer.id, standIn.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: writer.id } } }, { status: 201 })).group;
    const launch = { ...made, activeTaskId: made.activeTaskId ?? made.threadId };
    expect(launch.memberIds).toEqual([writer.id, standIn.id]);
    const atlasTurns = () => home.providerTurns().filter((turn) => turn.botId === atlas.id).length;
    const turnsBefore = atlasTurns();
    home.plan(atlas.id, { reply: "Atlas here: 42 orders this week. @Writer please confirm." });
    computer.plan(writer.id, { reply: "Writer confirms: 42." });
    await computer.cli("send-channel", "--channel", launch.id, "--text", "@Atlas how many orders this week?");
    const fromAtlas = async () => (await computer.messages(launch.activeTaskId)).filter((message) => message.kind === "text" && message.from?.botId === standIn.id);
    await expect.poll(async () => (await fromAtlas()).map((message) => message.text), { timeout: 40_000 }).toEqual(["Atlas here: 42 orders this week. @Writer please confirm."]);
    await expect.poll(async () => (await computer.messages(launch.activeTaskId)).some((message) => message.kind === "text" && message.from?.botId === writer.id && message.text === "Writer confirms: 42."), { timeout: 40_000 }).toBe(true);
    expect(atlasTurns()).toBe(turnsBefore + 1);
    const roomWork = (await home.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === atlas.id).tasks.find((task: any) => task.title === "@Launch · work");
    expect(roomWork, "the room's turns run in one thread of their own on the server").toBeTruthy();
    const read = (await home.messages(roomWork.threadId)).map((message) => message.text ?? "").join("\n");
    expect(read).toContain("room \"Launch\"");
    expect(read).toContain("how many orders this week?");
    // The room is kept across a restart's load rule: its far member is still a member in the saved record.
    expect(JSON.parse(readFileSync(join(computer.dataDir, "groups.json"), "utf8")).find((group: any) => group.id === launch.id).memberIds).toEqual([writer.id, standIn.id]);

    // Off on the computer: the server is told, and neither keeps the link.
    expect(await computer.api("PUT", "/api/bot-link", { on: false })).toEqual({ on: false });
    await expect.poll(() => existsSync(join(home.dataDir, "bot-link.json")), { timeout: 10_000 }).toBe(false);
    expect((await computer.api("GET", "/api/bot-link/bots")).bots).toEqual([]);
    // Turning the link off removes nobody from a room: the far member stays, named, marked as out of reach, and takes no turn.
    const savedMembers = () => JSON.parse(readFileSync(join(computer.dataDir, "groups.json"), "utf8")).find((group: any) => group.id === launch.id).memberIds;
    expect(savedMembers()).toEqual([writer.id, standIn.id]);
    // Saving the members again, with an address no record answers to among them, is not refused: that address is left out.
    const resaved = (await computer.api("PATCH", `/api/groups/${launch.id}`, { memberIds: [writer.id, standIn.id, "link-0000abcd-nobody"] })).group;
    expect(resaved.memberIds).toEqual([writer.id, standIn.id]);
    expect(resaved.farMembers).toEqual([{ id: standIn.id, name: "Atlas", place: "My server", state: "off" }]);
    await computer.cli("send-channel", "--channel", launch.id, "--text", "@Atlas are you there?");
    await expect.poll(async () => (await computer.messages(launch.activeTaskId)).some((message) => message.kind === "activity" && /The link to My server is off now/u.test(message.tool?.name ?? "")), { timeout: 20_000 }).toBe(true);
    expect(atlasTurns()).toBe(turnsBefore + 1);
    // The person removes it: then nothing of it is left here.
    const without = (await computer.api("PATCH", `/api/groups/${launch.id}`, { memberIds: [writer.id] })).group;
    expect(without.memberIds).toEqual([writer.id]);
    expect(without.farMembers).toBeUndefined();
    expect(savedMembers()).toEqual([writer.id]);
    await computer.api("GET", `/api/bots/${standIn.id}`, undefined, { status: 404 });
    expect(existsSync(join(computer.dataDir, "bot-link-rooms.json"))).toBe(false);
    await home.api("POST", "/api/bot-link/sync", { ack: 0, frames: [], wait: 0 }, { token: paired.token, status: 401 });
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 180_000);

it("mixed final admission refuses an unowned local thread and local reach revoked during approval", async () => {
  const local = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(import.meta.dirname, "no-mixed-admission-finish-gate") });
  let remote: Fixture | undefined;
  try {
    remote = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
    const computer = place(local), home = place(remote);
    const writer = (await computer.cli("new-bot", "--name", "Writer")).bot;
    const editor = (await computer.cli("new-bot", "--name", "Editor")).bot;
    const atlas = (await home.cli("new-bot", "--name", "Atlas")).bot;
    const pairing = await home.api("POST", "/api/auth/pairing", { label: "Fixture app", scopes: ["admin", "client"] });
    const owner = (await home.api("POST", "/api/auth/pair", { code: pairing.code })).token as string;
    const id = (await computer.api("GET", "/.well-known/openmausbot/environment")).environmentId as string;
    const paired = await home.api("POST", "/api/bot-link/pair", { computer: { id, name: "Fixture computer" }, name: "Fixture home" }, { token: owner });
    await computer.api("PUT", "/api/bot-link", { on: true, origin: home.url, token: paired.token, name: "Fixture computer", cloud: paired.place });
    const linked = linkedAddress(paired.place.id, atlas.id);
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link/bots")).bots.map((bot: { id: string }) => bot.id), { timeout: 15_000 }).toContain(linked);
    await computer.api("PATCH", `/api/bots/${writer.id}`, { approvePeerComms: true, approvalMode: "ask", peers: [editor.id, linked] });
    const threadId = writer.activeTaskId as string;
    await computer.cli("send", "--bot", writer.id, "--task", threadId, "--text", "Hold open this synthetic coordination turn.");
    const token = () => {
      try { return JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string; }
      catch { return ""; }
    };
    await expect.poll(token, { timeout: 15_000 }).toMatch(/^[a-f0-9]{48}$/);
    const allow = async (target: string, message: string, beforeAllow?: () => Promise<unknown>) => {
      const card = async () => (await computer.messages(threadId)).find((row) => row.card?.allowKey?.endsWith(`:${target}`) && row.card.subtitle === message && !row.card.answered)?.card;
      await expect.poll(async () => (await card())?.requestId, { timeout: 10_000 }).toBeTruthy();
      const requestId = (await card()).requestId;
      await beforeAllow?.();
      await computer.api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "allow" });
    };
    const outcomes = [];
    for (const [thread, message, revoke] of [[editor.activeTaskId, "Use the unowned local thread", false], ["standing", "Recheck the local peer scope", true]] as const) {
      const previous = new Set(readHandoffs(computer.dataDir).map((node) => node.id));
      const pending = fetch(`${computer.url}/api/internal/coordinate-bots`, { method: "POST",
        headers: { "content-type": "application/json", origin: computer.url, authorization: `Bearer ${token()}` },
        body: JSON.stringify({ botIds: [editor.id, linked], message, thread }), signal: AbortSignal.timeout(25_000) });
      void pending.catch(() => {});
      await allow(linked, message);
      await allow(editor.id, message, revoke ? () => computer.api("PATCH", `/api/bots/${writer.id}`, { peers: [linked] }) : undefined);
      const response = await pending;
      outcomes.push({ status: response.status, body: await response.json(), enqueues: readHandoffs(computer.dataDir).filter((node) => node.parentId && !previous.has(node.id)).map((node) => node.botId) });
    }
    expect(outcomes).toEqual([
      { status: 403, body: { error: expect.stringContaining("is not a thread you opened") }, enqueues: [] },
      { status: 403, body: { error: expect.stringContaining("is not one of the bots Writer is set to talk to") }, enqueues: [] },
    ]);
  } finally {
    await Promise.all([local.close(), remote?.close()]);
  }
}, 90_000);
