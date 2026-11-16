import * as mdb from "./message-db.ts";
import type { Message } from "./store.ts";

export function forkHistory(path: Message[], messageId: string): Message[] | null {
  const anchor = path.findIndex((message) => message.id === messageId);
  if (anchor < 0 || path[anchor]?.kind !== "text" || !["user", "bot"].includes(path[anchor]!.role)) return null;
  return structuredClone(path.slice(0, anchor + 1));
}

export function importFork(threadId: string, history: Message[], messageId: string, register: () => void): void {
  mdb.importThread(threadId, history, messageId);
  try {
    register();
  } catch (error) {
    try { mdb.deleteThread(threadId); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "could not roll back the imported fork");
    }
    throw error;
  }
}
