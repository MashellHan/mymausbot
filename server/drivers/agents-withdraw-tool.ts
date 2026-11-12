import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export async function callWithdrawWaitingThread(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const threadId = typeof args.thread_id === "string" ? args.thread_id.trim() : "";
  if (!/^[\w-]+$/.test(threadId)) return { text: "withdraw_waiting_thread needs an exact thread_id from list_threads.", isError: true };
  const { ok, body } = await context.client.apiResponse(`/api/internal/threads/${threadId}/withdraw-wait`, { method: "POST" });
  if (!ok) return { text: `Could not withdraw that wait: ${String(body.error ?? "request refused")}`, isError: true };
  if (body.threadId !== threadId || body.waiting !== false || typeof body.withdrawn !== "boolean") {
    return { text: "The server did not confirm the waiting thread's state.", isError: true };
  }
  return { text: body.withdrawn === true
    ? "That thread's wait was withdrawn. Its conversation and messages remain; the person can start new work there later."
    : "That thread is no longer waiting for an answer. Nothing was changed." };
}
