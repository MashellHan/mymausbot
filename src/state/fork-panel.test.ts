import { expect, it } from "vitest";
import { addForkOptimistic, reduceForkPanel, type ForkPanelState } from "./fork-panel";
import { initialState, reducer, type AppState, type Message } from "./store";

const source: Message = { id: "source", role: "user", kind: "text", text: "Start", at: 1, parentId: null };
const panel = (): ForkPanelState => ({
  kind: "bot", ownerId: "bot", threadId: "fork", messages: [source], activeLeafId: source.id,
  loading: false, loadId: "load-1", loadFailed: false,
});
const state = (): AppState => ({ ...initialState,
  bots: [{ id: "bot", threadId: "main", messages: [], tasks: [{ threadId: "fork" }] }], forkPanel: panel(),
}) as unknown as AppState;

it("restores the fork leaf after a failed send without retaining a background optimistic row", () => {
  const sent = addForkOptimistic(state(), { type: "send", botId: "bot", threadId: "fork", text: "Continue", sendId: "send-1" });
  expect(sent.forkPanel?.activeLeafId).toBe("optimistic-send-1");
  const removed = reducer(sent, { type: "optimisticMessageRemoved", threadId: "fork", sendId: "send-1" });
  expect(removed.forkPanel?.messages).toEqual([source]);
  expect(removed.forkPanel?.activeLeafId).toBe(source.id);
});

it("reconciles a confirmed send but leaves off-path messages off the selected branch", () => {
  const sent = addForkOptimistic(state(), { type: "send", botId: "bot", threadId: "fork", text: "Continue", sendId: "send-1" });
  const confirmed: Message = { id: "confirmed", role: "user", kind: "text", text: "Continue", at: 2, parentId: source.id, sendId: "send-1" };
  const arrived = reduceForkPanel(sent, { type: "forkPanelMessage", threadId: "fork", message: confirmed });
  expect(arrived.forkPanel?.messages.map((message) => message.id)).toEqual(["source", "confirmed"]);
  expect(arrived.forkPanel?.activeLeafId).toBe("confirmed");
  const late = reduceForkPanel(arrived, { type: "forkPanelMessage", threadId: "fork",
    message: { ...confirmed, id: "off-path", parentId: source.id, sendId: undefined } });
  expect(late.forkPanel?.activeLeafId).toBe("confirmed");
});

it("ignores a stale failed load after retry and prefers live patches over fetched history", () => {
  const retry = reduceForkPanel(state(), { type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "fork", loadId: "load-2" });
  expect(reduceForkPanel(retry, { type: "forkPanelLoadFailed", threadId: "fork", loadId: "load-1" })).toBe(retry);
  const patched = reduceForkPanel(retry, { type: "forkPanelMessage", threadId: "fork", message: { ...source, text: "Updated" }, patch: true });
  const loaded = reduceForkPanel(patched, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source], activeLeafId: source.id });
  expect(loaded.forkPanel?.messages[0]?.text).toBe("Updated");
  expect(loaded.forkPanel?.loadFailed).toBe(false);
});
