import type { Action, AppState, Message } from "./store";

type OlderPage = { messages: Message[]; hasMore?: boolean };

export function createOlderMessagesLoader(
  state: () => AppState,
  dispatch: (action: Action) => void,
  selectionRevision: () => number,
  loadPage: (threadId: string, before: string) => Promise<OlderPage>,
  showError: (error: unknown) => void,
) {
  const inFlight = new Map<string, object>();
  return (action: Extract<Action, { type: "loadOlderMessages" }>) => {
    const { threadId } = action;
    if (inFlight.has(threadId)) return;
    const request = {};
    inFlight.set(threadId, request);
    const current = state();
    const before = [...current.bots, ...current.groups].find((owner) => owner.threadId === threadId)?.messages[0]?.id;
    const generation = current.transcriptGeneration[threadId] ?? 0;
    const selection = selectionRevision();
    if (!before) {
      inFlight.delete(threadId);
      dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: false });
      return;
    }
    void loadPage(threadId, before)
      .then((page) => dispatch({ type: "olderMessages", threadId, generation,
        messages: page.messages ?? [], hasMore: Boolean(page.hasMore) }))
      .catch((error) => {
        const report = inFlight.get(threadId) === request && selectionRevision() === selection
          && (state().transcriptGeneration[threadId] ?? 0) === generation;
        dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true });
        if (report) {
          action.onError?.(error instanceof Error ? error : new Error(String(error)));
          showError(error);
        }
      })
      .finally(() => {
        if (inFlight.get(threadId) === request) inFlight.delete(threadId);
      });
  };
}
