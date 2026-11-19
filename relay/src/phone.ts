import { channel } from "node:diagnostics_channel";
import { WebSocket } from "ws";
import type { Context } from "./context.ts";
import { afterFirstMessage, closeWith, sendJson } from "./socket.ts";
import { Session } from "./splice.ts";
import { Close, parsePhoneHello, sha256 } from "./wire.ts";

const admissionTrace = channel("openmausbot.relay.admission");

/**
 * `GET /v1/phone`: a phone names a host and proves admission. An absent host and an unadmitted phone get the same 4404,
 * so a phone without a pairing cannot learn whether a computer is online.
 */
export function handlePhone(ctx: Context, ws: WebSocket): void {
  afterFirstMessage(ctx, ws, (message) => {
    const hello = parsePhoneHello(message);
    if (!hello) return void closeWith(ctx, ws, Close.Malformed);
    const admHash = sha256(hello.adm);
    const entry = ctx.hosts.get(hello.hidText);
    if (!ctx.hosts.admitted(entry, admHash) || !entry?.control) {
      if (admissionTrace.hasSubscribers) admissionTrace.publish({ phase: "phone_admission_refused", code: Close.NotFound, socketState: entry?.control?.readyState ?? null });
      return void closeWith(ctx, ws, Close.NotFound);
    }
    if (admissionTrace.hasSubscribers) admissionTrace.publish({ phase: "phone_admitted", socketState: entry.control.readyState });
    if (entry.sessions.size >= ctx.limits.hostSessionsMax || ctx.budgets.over(entry.hidText)) {
      return void closeWith(ctx, ws, Close.Limited);
    }
    const session = new Session(ctx, entry, admHash, ws);
    sendJson(entry.control, { t: "open", sid: session.sid });
    if (admissionTrace.hasSubscribers && entry.control.readyState === WebSocket.OPEN) admissionTrace.publish({ phase: "open_sent_to_host" });
    return (data, isBinary) => session.fromPhone(data, isBinary);
  });
}
