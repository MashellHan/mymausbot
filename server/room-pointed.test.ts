import { describe, expect, it } from "vitest";
import { copyRoomPick, pointedResponders, prepareRoomPointed, roomPickBots, takeRoomPick, undeliveredPickBots, type RoomPick } from "./room-pointed.ts";

const pick = (blocks: Record<string, string>): RoomPick => ({ refs: [{ appId: "app-1", label: "Go" }], blocks });

describe("room picks", () => {
  it("gives each bot the records of its own pages once, and nothing to another member", () => {
    const holder = { pick: pick({ designer: "A", writer: "B" }) };
    expect(roomPickBots(holder.pick)).toEqual(["designer", "writer"]);
    expect(takeRoomPick(holder, "helper")).toBe("");
    expect(takeRoomPick(holder, "designer")).toBe("A");
    expect(takeRoomPick(holder, "designer")).toBe("");
    expect(takeRoomPick(holder, "writer")).toBe("B");
    expect(takeRoomPick(undefined, "designer")).toBe("");
    expect(takeRoomPick({}, "designer")).toBe("");
    expect(roomPickBots(undefined)).toEqual([]);
  });

  it("works on a copy, so taking a part leaves the queued line's pick whole", () => {
    const queued = pick({ designer: "A" });
    const run = { pick: copyRoomPick(queued) };
    expect(takeRoomPick(run, "designer")).toBe("A");
    expect(queued.blocks).toEqual({ designer: "A" });
  });

  it("keeps the message's chip numbers when different bots own the picked pages", () => {
    const store = { messagesFor: () => [
      { id: "page-a", kind: "app", app: { source: "html", title: "First", rev: 0 }, from: { botId: "designer" } },
      { id: "page-b", kind: "app", app: { source: "html", title: "Second", rev: 0 }, from: { botId: "writer" } },
    ] } as unknown as Parameters<typeof prepareRoomPointed>[0];
    const part = { rev: 0, tag: "button", role: "", selector: "button", html: "<button>Go</button>" };
    const result = prepareRoomPointed(store, "room", [
      { ...part, appId: "page-a", text: "First", note: "make it large" },
      { ...part, appId: "page-b", text: "Second", note: "make it blue" },
    ]);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.pick.blocks.designer).toContain("1. <button>; text: First");
    expect(result.pick.blocks.designer).not.toContain("Second");
    expect(result.pick.blocks.writer).toContain("2. <button>; text: Second");
    expect(result.pick.blocks.writer).toContain("2. make it blue");
    expect(result.pick.blocks.writer).not.toContain("First");
  });

  it("sends the line to the page's bot first, then anyone named, and to no hidden member", () => {
    const designer = { id: "designer" }, helper = { id: "helper" }, writer = { id: "writer", hidden: true };
    const members = [helper, designer, writer];
    expect(pointedResponders(pick({ designer: "A" }), members, () => [helper, designer])).toEqual([designer, helper]);
    expect(pointedResponders(pick({ writer: "B" }), members, () => [helper])).toEqual([]);
    expect(pointedResponders(undefined, members, () => [helper])).toEqual([]);
  });
  it("names the page bots that will not answer the line, so their part can be reported", () => {
    const both = pick({ a: "A", b: "B" });
    expect(undeliveredPickBots(both, [{ id: "a" }, { id: "c" }])).toEqual(["b"]);
    expect(undeliveredPickBots(both, [{ id: "a" }, { id: "b" }])).toEqual([]);
    expect(undeliveredPickBots(undefined, [])).toEqual([]);
  });
});
