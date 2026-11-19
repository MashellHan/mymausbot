import { expect, it } from "vitest";
import { addForkOptimistic, reduceForkPanel, type ForkPanelState } from "./fork-panel";
import { visibleMessages } from "./snapshot-navigation";
import { initialState, reducer, type AppState, type Message } from "./store";

const source: Message = { id: "source", role: "user", kind: "text", text: "Start", at: 1, parentId: null };
const panel = (): ForkPanelState => ({
  kind: "bot", ownerId: "bot", threadId: "fork", messages: [source], activeLeafId: source.id,
  loading: false, loadingAppends: [], loadId: "load-1", loadFailed: false,
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
  const failed = reduceForkPanel(retry, { type: "forkPanelLoadFailed", threadId: "fork", loadId: "load-2" });
  expect(failed.forkPanel).toMatchObject({ loading: false, loadFailed: true });
  const patched = reduceForkPanel(retry, { type: "forkPanelMessage", threadId: "fork", message: { ...source, text: "Updated" }, patch: true });
  const loaded = reduceForkPanel(patched, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source], activeLeafId: source.id });
  expect(loaded.forkPanel?.messages[0]?.text).toBe("Updated");
  expect(loaded.forkPanel?.loadFailed).toBe(false);
});

it("extends the fetched leaf through live appends received during hydration", () => {
  const loading = reduceForkPanel(state(), { type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "fork", loadId: "load-2" });
  const next = { ...source, id: "next", text: "Next", at: 2, parentId: source.id };
  const reply = { ...source, id: "reply", text: "Reply", at: 3, parentId: next.id };
  const aside = { ...source, id: "aside", text: "Aside", at: 4, parentId: source.id };
  let live = reduceForkPanel(loading, { type: "forkPanelMessage", threadId: "fork", message: next });
  live = reduceForkPanel(live, { type: "forkPanelMessage", threadId: "fork", message: aside });
  live = reduceForkPanel(live, { type: "forkPanelMessage", threadId: "fork", message: reply });
  live = reduceForkPanel(live, { type: "forkPanelMessage", threadId: "fork", message: { ...source, text: "Patched" }, patch: true });
  expect(reduceForkPanel(live, { type: "forkPanelLoaded", threadId: "fork", loadId: "old", messages: [source], activeLeafId: source.id })).toBe(live);
  const loaded = reduceForkPanel(live, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2", messages: [source], activeLeafId: source.id });
  expect(loaded.forkPanel?.messages.map((message) => message.id)).toEqual(["source", "next", "aside", "reply"]);
  expect(loaded.forkPanel?.messages[0]?.text).toBe("Patched");
  expect(loaded.forkPanel?.activeLeafId).toBe(reply.id);
  expect(visibleMessages(loaded.forkPanel!).map((message) => message.id)).toEqual(["source", "next", "reply"]);
  const child = { ...source, id: "child", text: "Child", at: 5, parentId: reply.id };
  expect(reduceForkPanel(loaded, { type: "forkPanelMessage", threadId: "fork", message: child }).forkPanel?.activeLeafId).toBe(child.id);
});

it("keeps loading-time branch choices while following later descendants, not earlier or off-path rows", () => {
  const loading = reduceForkPanel(state(), { type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "fork", loadId: "load-2" });
  const child = { ...source, id: "child", at: 2, parentId: source.id };
  const appended = reduceForkPanel(loading, { type: "forkPanelMessage", threadId: "fork", message: child });
  const selected = reduceForkPanel(appended, { type: "forkPanelActive", threadId: "fork", activeLeafId: source.id });
  expect(reduceForkPanel(selected, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source], activeLeafId: source.id }).forkPanel?.activeLeafId).toBe(source.id);
  const later = { ...child, id: "later", at: 3 };
  const reply = { ...child, id: "reply", at: 4, parentId: later.id };
  const aside = { ...child, id: "aside", at: 5 };
  let live = reduceForkPanel(selected, { type: "forkPanelMessage", threadId: "fork", message: later });
  const overlapping = reduceForkPanel(live, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source, later], activeLeafId: later.id });
  expect(overlapping.forkPanel?.activeLeafId).toBe(later.id);
  expect(visibleMessages(overlapping.forkPanel!).map((message) => message.id)).toEqual([source.id, later.id]);
  live = reduceForkPanel(live, { type: "forkPanelMessage", threadId: "fork", message: aside });
  live = reduceForkPanel(live, { type: "forkPanelMessage", threadId: "fork", message: reply });
  const loaded = reduceForkPanel(live, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source], activeLeafId: source.id });
  expect(loaded.forkPanel?.activeLeafId).toBe(reply.id);
  expect(visibleMessages(loaded.forkPanel!).map((message) => message.id)).toEqual([source.id, later.id, reply.id]);
  const patched = reduceForkPanel(loading, { type: "forkPanelMessage", threadId: "fork", message: child, patch: true });
  expect(reduceForkPanel(patched, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2",
    messages: [source], activeLeafId: source.id }).forkPanel?.activeLeafId).toBe(source.id);
});
