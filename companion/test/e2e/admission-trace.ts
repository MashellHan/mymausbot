import type { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { fileURLToPath } from "node:url";
import { SessionClosed } from "../../src/e2e/session.ts";

const relayAdmission = channel("openmausbot.relay.admission");
export const admissionTraceArgs = ["--import", fileURLToPath(import.meta.url)];
export const admissionTraceEnv = { OMB_TEST_ADMISSION_TRACE_CHILD: "1" };
const eventLimit = 256;
const phases = new Set([
  "refresh_timer_scheduled", "refresh_timer_fired", "admission_refresh", "relay_control_received",
  "relay_control_closed", "relay_admit_result", "phone_admission_refused", "phone_admitted",
  "open_sent_to_host", "host_data_attach_seen", "relay_spliced_ready_sent", "relay_no_data_socket",
  "relay_ready_seen", "noise_started", "noise_ready", "noise_deadline", "outer_deadline",
  "dial_ready", "dial_closed",
]);
const statusNames = new Set(["off", "connecting", "connected"]);
const resultNames = new Set(["sent", "not-connected", "unchanged", "limited", "malformed", "accepted"]);
const roleNames = new Set(["phone", "computer"]);
const terminalNames = new Set(["4404", "4408", "4002", "4001", "outer_deadline", "other-close"]);

function sanitize(value: unknown): Record<string, string | number | boolean | null> | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.phase !== "string" || !phases.has(raw.phase)) return null;
  const event: Record<string, string | number | boolean | null> = { phase: raw.phase };
  for (const key of ["code", "socketState", "count", "attempt", "elapsedMs", "budgetMs"] as const) {
    const field = raw[key];
    if (field === null || typeof field === "number" && Number.isSafeInteger(field) && field >= 0) event[key] = field;
  }
  for (const [key, names] of [["status", statusNames], ["result", resultNames], ["role", roleNames], ["terminal", terminalNames]] as const) {
    const field = raw[key];
    if (typeof field === "string" && names.has(field)) event[key] = field;
  }
  if (typeof raw.current === "boolean") event.current = raw.current;
  if (typeof raw.digest === "string" && /^[a-f0-9]{64}$/.test(raw.digest)) event.digest = raw.digest;
  return event;
}

if (process.env.OMB_TEST_ADMISSION_TRACE_CHILD === "1") {
  relayAdmission.subscribe((value) => {
    const event = sanitize(value);
    if (event && process.connected) process.send?.({ at: Date.now(), event }, () => {});
  });
}

type Source = "sidecar" | "relay" | "phone";
type TraceEvent = { at: number; event: NonNullable<ReturnType<typeof sanitize>> };

export class AdmissionTrace {
  #events: Record<Source, TraceEvent[]> = { sidecar: [], relay: [], phone: [] };
  #attempt = 0;

  #record(source: Source, at: number, value: unknown): void {
    const event = sanitize(value);
    if (!event) return;
    const entries = this.#events[source];
    if (entries.length >= eventLimit) entries.shift();
    entries.push({ at, event });
  }

  watch(child: ChildProcess, source: "sidecar" | "relay"): void {
    child.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const { at, event } = value as Partial<TraceEvent>;
      if (typeof at === "number" && Number.isSafeInteger(at)) this.#record(source, at, event);
    });
  }

  begin(): number {
    this.#events = { sidecar: [], relay: [], phone: [] };
    this.#attempt = 0;
    return Date.now();
  }

  async dial<T>(action: () => Promise<T>): Promise<T> {
    const attempt = ++this.#attempt;
    const began = performance.now();
    let outer = false;
    const onEvent = (value: unknown) => {
      const event = sanitize(value);
      if (!event) return;
      if (event.phase === "outer_deadline") outer = true;
      this.#record("phone", Date.now(), { ...event, attempt });
    };
    relayAdmission.subscribe(onEvent);
    try {
      const result = await action();
      this.#record("phone", Date.now(), { phase: "dial_ready", attempt, elapsedMs: Math.round(performance.now() - began) });
      return result;
    } catch (error) {
      const code = error instanceof SessionClosed ? error.code : null;
      const reason = String(code);
      const terminal = outer ? "outer_deadline" : terminalNames.has(reason) ? reason : "other-close";
      this.#record("phone", Date.now(), { phase: "dial_closed", attempt, elapsedMs: Math.round(performance.now() - began), code, terminal });
      throw error;
    } finally {
      relayAdmission.unsubscribe(onEvent);
    }
  }

  report(startedAt: number, http201At: number): void {
    const entries = Object.entries(this.#events).flatMap(([source, events]) => events
      .filter(({ at }) => at >= startedAt)
      .map(({ at, event }) => ({ source, ms: at - http201At, ...event })));
    console.warn("initial relay admission trace " + JSON.stringify({
      filter: "post-http-201",
      attempts: this.#attempt,
      events: entries.sort((a, b) => a.ms - b.ms),
    }));
  }
}
