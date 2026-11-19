import { EMAIL_CREDENTIAL } from "../../shared/email.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

/** One card for a mailbox's address and password: the bot never sees either go by, and the email tools arrive when it is done. */
export async function requestEmailCard(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const r = await context.client.apiResponse("/api/internal/request-credential", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, credentialId: EMAIL_CREDENTIAL, address: args.address, reason: args.reason }),
  });
  if (!r.ok) return { text: String(r.body.error ?? `request_credential failed (HTTP ${r.status}).`), isError: true };
  if (r.body.alreadyConfigured === true) return { text: typeof r.body.text === "string" ? r.body.text : `${String(r.body.label)} is already connected. Use the email tools.` };
  if (r.body.outgoing === true) return { text: "A secure card for the mailbox's outgoing server is ready in OpenMausBot, on the computer and on a freshly QR-paired phone. End this turn now and say in one line that you are waiting for it; OpenMausBot resumes you when the person saves it or declines, and says whether sending works." };
  return { text: "A secure card for the mailbox is ready in OpenMausBot, on the computer and on a freshly QR-paired phone. End this turn now and say in one line that you are waiting for it; OpenMausBot resumes you when the person connects it or declines." };
}

/** Any other secret: from the Vault at once, or from a card the person answers; the bot gets a secretRef or a file path back. */
export async function requestCustomSecret(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const r = await context.client.apiResponse("/api/internal/request-credential", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, label: args.label, reason: args.reason, placeholder: args.placeholder, delivery: args.delivery, replace: args.replace === true }),
  });
  const label = typeof r.body.label === "string" ? r.body.label : "the secret";
  if (!r.ok) return { text: String(r.body.error ?? `request_credential failed (HTTP ${r.status}).`), isError: true };
  if (typeof r.body.text === "string") return { text: `${r.body.text} Continue the task.` };
  const asked = r.body.savedAs === "ref" ? ` ${label} was saved earlier for OpenMausBot's tools only, not as a file for your commands (not a file request), so this card asks for it again.` : "";
  return {
    text: `A secure card for ${label} is now in this conversation, in the app and on a QR-paired phone, and the person was notified. If they can't find it, tell them it is in this conversation, and the notification opens it.${asked} End this turn now and say in one line that you are waiting for it; OpenMausBot resumes you when the person saves or declines, and tells you how to use it. Never ask for it in chat.`,
  };
}
