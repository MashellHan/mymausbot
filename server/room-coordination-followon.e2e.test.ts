import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PEER_ACCESS_HELP } from "./peer-roster.ts";
import { parseCompleteJsonLines } from "./testing/complete-json-lines.ts";
import { withRooms } from "./testing/room-coordination-fixture.ts";

it("keeps a busy recipient queued and rejects revoked peer access before dispatch", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 2000;
  f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent direct task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("failed");
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  await f.cli("wait", "--bot", f.target.id, "--timeout", "15");
}), 45_000);

it("stops awaiting on Stop in the source room, and stop means stop: the running downstream turn ends too, and nothing resumes the room", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 10_000;
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("running");
  await expect.poll(async () => {
    const { bots, groups } = await f.api("/api/bots?messages=0");
    const task = groups.find((g: any) => g.id === f.source.id)?.tasks?.find((t: any) => t.threadId === f.source.activeTaskId);
    return { senderBusy: bots.find((b: any) => b.id === f.sender.id)?.busy, taskWorking: task?.working };
  }, { timeout: 10_000 }).toEqual({ senderBusy: false, taskWorking: true });
  await f.cli("interrupt", "--channel", f.source.id);
  await expect.poll(() => f.nodes().map((n: any) => [Boolean(n.parentId), n.status]), { timeout: 5_000 }).toEqual([[false, "cancelled"], [true, "cancelled"]]);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => /still working; open to stop it too/.test(m.tool?.name ?? ""))).toBe(false);
  await expect.poll(async () => {
    const { bots } = await f.api("/api/bots"); return bots.find((b: any) => b.id === f.target.id)?.busy;
  }, { timeout: 10_000 }).toBeFalsy();
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text === "Built CSV")).toBe(false);
  expect(f.nodes().map((n: any) => n.status)).toEqual(["cancelled", "cancelled"]);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(false);
}), 45_000);

it.each(["allow", "deny"])("honors %s on the sender's peer-approval card", behavior => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true, approvalMode: "ask" }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let card: any;
  await expect.poll(async () => {
    card = (await f.messages(f.source.activeTaskId)).find((m: any) => m.card?.tool === "delegate_bot");
    return Boolean(card);
  }, { timeout: 10_000 }).toBe(true);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.cli("wait", "--channel", f.source.id, "--timeout", "3")).status).toBe("needs-user");
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: card.card.requestId, behavior });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.handoffs()).toEqual([]);
  else expect(f.handoffs()).toMatchObject([{ status: "completed", approvalGranted: true }]);
}), 45_000);

it.each(["allow", "deny"])("presents all peer approvals together and dispatches only if every recipient is allowed (%s)", behavior => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.destination.id, member_ids: [f.target.id, reviewer.id] });
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true, approvalMode: "ask" }, "PATCH");
  f.plan[reviewer.id] = { reply: "Reviewed CSV" };
  f.plan[f.sender.id].steps[0].arguments.bot_ids.push(reviewer.id);
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let cards: any[] = [];
  await expect.poll(async () => {
    cards = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.card?.tool === "delegate_bot");
    return cards.length;
  }, { timeout: 10_000 }).toBe(2);
  expect(f.handoffs()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  // Answer the second card first: approving one recipient must not start partial work.
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[1].card.requestId, behavior });
  expect(f.handoffs()).toEqual([]);
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[0].card.requestId, behavior: "allow" });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.handoffs()).toEqual([]);
  else expect(f.handoffs()).toMatchObject([
    { status: "completed", approvalGranted: true }, { status: "completed", approvalGranted: true },
  ]);
  const posted = (await f.messages(f.destination.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(posted).toHaveLength(behavior === "deny" ? 0 : 1);
  if (behavior === "allow") expect(posted[0].text).toBe("@Engineer @Reviewer Please build CSV");

}), 45_000);

it("pins a busy destination's task even when its active task changes", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  const created = await f.tool("create_task", { target_type: "channel", target_id: f.destination.id, title: "Unrelated conversation" });
  expect((await f.wait()).status).toBe("settled");
  const nodes = f.nodes(); expect(nodes.find((n: any) => n.parentId).threadId).toBe(f.destination.activeTaskId);
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text === "Built CSV")).toBe(true);
  const current = (await f.api("/api/bots")).groups.find((g: any) => g.id === f.destination.id);
  expect(current.threadId).not.toBe(f.destination.activeTaskId);
  expect(await f.messages(current.threadId)).toEqual([]);
  expect(created.success).toBe(true);
}), 45_000);
it("consults multiple existing members and returns once, with no discussion prerequisite or new room settings", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [f.target.id, reviewer.id], message: "Give one risk from your role" } }];
  f.plan[reviewer.id] = { reply: "Privacy risk" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.sender.id]);
  const source = await f.messages(f.source.activeTaskId);
  expect(source.filter((m: any) => m.comm).map((m: any) => m.comm.withBotId)).toEqual([f.target.id, reviewer.id]);
  expect(source.filter((m: any) => m.text === "Reviewed downstream outcome")).toHaveLength(1);
  const requests = source.filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toBe("@Engineer @Reviewer Give one risk from your role");
  for (const id of [f.target.id, reviewer.id]) {
    expect(JSON.stringify(f.provider().find((turn: any) => turn.botId === id).prompt).match(/Give one risk from your role/g)).toHaveLength(1);
  }

  const tools = f.provider()[0].evidence[0].result.tools.map((t: any) => t.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).toContain("request_credential");
  for (const old of ["discuss_room", "assign_room_member", "delegate_bot", "ask_bot", "send_to_bot", "check_delegation", "wait_delegation"]) {
    expect(tools).not.toContain(old);
  }
}), 45_000);

it.each([false, true])("retains reports behind compact receipts for later turns, unless access is revoked (%s)", revoked => withRooms(async f => {
  const report = "Nora executed python3 -m unittest: 3 tests passed.";
  const firstSteps = f.plan[f.sender.id].steps;
  f.plan[f.sender.id] = { turns: [
    { steps: firstSteps, reply: "Assigned" },
    { reply: "Reviewed downstream outcome" },
    { reply: "Follow-up answered", expectContextIncludes: [revoked ? "Teammate result withheld" : report] },
  ] };
  f.plan[f.target.id].reply = report;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const receipt = (await f.messages(f.source.activeTaskId)).find((m: any) => m.roomRequest?.phase === "result");
  expect(receipt.kind).toBe("activity");
  expect(receipt.text).toBeUndefined();
  if (revoked) await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  await f.cli("send-channel", "--channel", f.source.id, "--text", "Did the reviewer actually run tests? Do not start new work.");
  expect((await f.wait()).status).toBe("settled");
  const followup = f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1);
  expect(followup.turnIndex).toBe(2);
  expect(JSON.stringify(followup.prompt).includes(report)).toBe(!revoked);
  expect(f.nodes().map((n: any) => [n.botId, Boolean(n.parentId)])).toEqual([[f.sender.id, false], [f.target.id, true], [f.sender.id, false]]);
}), 45_000);

it("waits for busy peers and then completes without the user relaying messages", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);

it.each([
  ["a name nobody has in a bot_ids slot", false],
  ["a hidden teammate's id", true],
] as const)("refuses %s with a message the caller can act on", (_case, hidden) => withRooms(async f => {
  if (hidden) await f.api(`/api/bots/${f.target.id}`, { hidden: true }, "PATCH");
  const botId = hidden ? f.target.id : "Nobody";
  f.plan[f.sender.id].steps = [{ expectError: true, arguments: { group_id: f.destination.id, bot_ids: [botId], message: "Review CSV" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.handoffs()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  const refused = f.provider().find((turn: any) => turn.botId === f.sender.id)
    .evidence.find((entry: any) => entry.step).response.result.content[0].text;
  if (hidden) expect(refused).toBe(`The bot with id "${botId}" is no longer available — call list_bots for the ones you can reach`);
  else {
    expect(refused.startsWith(`No bot with id or name "${botId}" — call list_bots and copy the exact id from the result. You can reach: `)).toBe(true);
    expect(refused).toContain(`${f.target.name} (id ${f.target.id})`);
    expect(refused.endsWith(` ${PEER_ACCESS_HELP}`)).toBe(true);
  }
}), 45_000);

it("resolves a unique teammate name in a bot_ids slot, and refuses an ambiguous one", () => withRooms(async f => {
  f.plan[f.sender.id].steps = [{ arguments: { group_id: f.destination.id, bot_ids: [f.target.name], message: "Please build CSV" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((n: any) => n.parentId);
  expect(node.botId).toBe(f.target.id);
  expect(node.status).toBe("completed");
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text?.includes("Please build CSV"))).toBe(true);

  const twin = (await f.cli("new-bot", "--name", f.target.name, "--section", "A")).bot;
  expect(twin.id).not.toBe(f.target.id);
  f.plan[f.sender.id] = { steps: [{ expectError: true, arguments: { group_id: f.destination.id, bot_ids: [f.target.name], message: "Review CSV" } }], reply: "Refused" };
  f.savePlan(); await f.cli("send-channel", "--channel", f.source.id, "--text", "@Director Ask again");
  expect((await f.wait()).status).toBe("settled");
  const refused = f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1)
    .evidence.find((entry: any) => entry.step).response.result.content[0].text;
  expect(refused).toContain(`2 teammates you can reach are named "${f.target.name}", so nothing was sent:`);
  expect(refused).toContain(`(id ${f.target.id})`);
  expect(refused).toContain(`(id ${twin.id})`);
  expect(refused).toContain("Send it again with the id of the one you mean.");
}), 60_000);

it("does not repeat a shared brief or rerun recipients on an identical tool retry", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  const args = { bot_ids: [f.target.id, reviewer.id], message: "Review the release checklist" };
  f.plan[f.sender.id].steps = [{ arguments: args }, { arguments: args }];
  f.plan[reviewer.id] = { reply: "Release checklist reviewed" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const requests = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toBe("@Engineer @Reviewer Review the release checklist");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.sender.id]);
}), 45_000);

it("keeps genuinely different room briefs separate", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  f.plan[f.sender.id].steps = [
    { arguments: { bot_ids: [f.target.id], message: "Check the migration" } },
    { arguments: { bot_ids: [reviewer.id], message: "Check the documentation" } },
  ];
  f.plan[reviewer.id] = { reply: "Documentation reviewed" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const requests = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests.map((m: any) => m.text)).toEqual(["@Engineer Check the migration", "@Reviewer Check the documentation"]);
}), 45_000);

it("runs a room member's turn a restart cut again once, told so, and resumes the sender told so", () => withRooms(async f => {
  const gateFile = join(f.session.info.dataDir, "engineer.gate");
  const evidenceFile = join(f.session.info.dataDir, "room-plan.json.evidence.jsonl");
  let childId: string | undefined;
  f.plan[f.target.id] = { reply: "Built CSV", gateFile };
  await f.start();
  await expect.poll(() => {
    const nodes = f.nodes(), child = nodes.find((node: any) => node.parentId);
    const parent = nodes.find((node: any) => node.id === child?.parentId);
    const evidence = existsSync(evidenceFile)
      ? parseCompleteJsonLines<{ botId: string; threadId: string }>(readFileSync(evidenceFile, "utf8")) : [];
    const senderRecorded = Boolean(parent && evidence.some((turn) => turn.botId === parent.botId && turn.threadId === parent.threadId));
    if (child?.status === "running" && senderRecorded) childId = child.id;
    return { childStatus: child?.status, senderRecorded };
  }, { timeout: 15_000 }).toMatchObject({ childStatus: "running", senderRecorded: true });
  await f.restart("SIGKILL");
  writeFileSync(gateFile, "open");
  await expect.poll(() => f.nodes().every((node: any) => node.status === "completed"), { timeout: 30_000 }).toBe(true);
  expect(f.nodes().find((node: any) => node.id === childId)).toMatchObject({ status: "completed", restarts: 1, executions: 2 });
  const turns = f.provider();
  expect(turns.map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  const [, rerun, review] = turns;
  expect(JSON.stringify(rerun.prompt)).toContain("this turn continues it");
  expect(review.resumed).toBe(true);
  expect(JSON.stringify(review.prompt)).toContain("A restart cut these teammates' turns: Engineer (resumed once in place");
  expect((await f.messages(f.source.activeTaskId)).filter((m: any) => m.text === "Reviewed downstream outcome")).toHaveLength(1);
  expect(f.nodes().map((n: any) => [n.botId, n.groupId, n.threadId, Boolean(n.parentId), n.restarts, n.executions])).toEqual([
    [f.sender.id, f.source.id, f.source.activeTaskId, false, 0, 2],
    [f.target.id, f.destination.id, f.destination.activeTaskId, true, 1, 2],
  ]);
  expect((await f.messages(f.source.activeTaskId)).filter((m: any) => /turn interrupted/.test(m.tool?.name ?? ""))).toEqual([]);
}), 60_000);

it("hands work a Chief addresses into its room to the bots it just made, which are not in the room, directly", () => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { section: "Sales OS", chiefOfStaff: true, acknowledgePeerScope: true }, "PATCH");
  const made = (name: string, key: string) => ({ tool: "create_bot", capture: { [key]: "\\[id: ([^\\]]+)\\]" },
    arguments: { name, role: `${name} lead`, instructions: `Own the ${name} part of the Sales OS.` } });
  f.plan[f.sender.id] = {
    steps: [made("Buyer Research", "buyer"), made("Sales Writer", "writer"), made("Revenue Ops", "ops"),
      { arguments: { group_id: f.source.id, bot_ids: ["{{buyer}}", "{{writer}}", "{{ops}}"], message: "Draft your part of the Sales OS" } }],
    reply: "Assigned", resumeReply: "Sales OS parts reviewed",
  };
  await f.start(); expect((await f.wait()).status).toBe("settled");

  const names = ["Buyer Research", "Sales Writer", "Revenue Ops"];
  const { bots, groups } = await f.api("/api/bots?messages=0", undefined, "GET");
  const made3 = names.map(name => bots.find((bot: any) => bot.name === name));
  expect(made3.map((bot: any) => bot?.section)).toEqual(["Sales OS", "Sales OS", "Sales OS"]);
  expect(groups.find((room: any) => room.id === f.source.id).memberIds).toEqual([f.sender.id]);

  const children = f.handoffs();
  expect(children.map((node: any) => node.botId).sort()).toEqual(made3.map((bot: any) => bot.id).sort());
  for (const node of children) {
    expect([node.status, node.groupId]).toEqual(["completed", undefined]);
    const task = made3.find((bot: any) => bot.id === node.botId).tasks.find((t: any) => t.threadId === node.threadId);
    expect(task.openedBy).toMatchObject({ botId: f.sender.id, threadId: f.source.activeTaskId, kind: "work" });
  }
  const turns = f.provider();
  for (const bot of made3) {
    const turn = turns.find((entry: any) => entry.botId === bot.id);
    expect(turn.threadId).toBe(children.find((node: any) => node.botId === bot.id).threadId);
    expect(JSON.stringify(turn.prompt)).toContain("Draft your part of the Sales OS");
    expect(`${turn.system}${JSON.stringify(turn.prompt)}`).not.toContain("SOURCE_ONLY");
  }
  const sent = JSON.parse(turns.find((entry: any) => entry.botId === f.sender.id).evidence.at(-1).response.result.content[0].text);
  expect(sent.receipts.map((receipt: any) => receipt.detail)).toEqual(names.map(() => expect.stringContaining("it isn't in this room, so it got this directly")));

  const room = await f.messages(f.source.activeTaskId);
  const notes = room.filter((m: any) => m.sentDirectly);
  expect(notes.map((m: any) => m.tool.name)).toEqual(names.map(name => `Sent to ${name} directly: it isn't in this room.`));
  expect(notes.map((m: any) => [m.sentDirectly, m.threadRef.botId, m.threadRef.threadId])).toEqual(made3.map((bot: any) =>
    [{ name: bot.name }, bot.id, children.find((node: any) => node.botId === bot.id).threadId]));
  const results = room.filter((m: any) => m.roomRequest?.phase === "result");
  expect(results.map((m: any) => m.tool.output).sort()).toEqual(made3.map((bot: any) => `Result from ${bot.id}`).sort());
  expect(turns.filter((entry: any) => entry.botId === f.sender.id).map((entry: any) => entry.resumed)).toEqual([false, true]);
  expect(room.filter((m: any) => m.text === "Sales OS parts reviewed")).toHaveLength(1);
  expect(room.filter((m: any) => m.card && !m.card.autoApplied && !m.card.answered)).toEqual([]);
}), 60_000);
