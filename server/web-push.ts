/** Self-hosted Web Push (RFC 8030 / 8291 / 8292) delivery pipeline, VAPID storage,
 * SSRF-guarded push delivery, lock-screen redaction, SSE focus dedupe, coalescing and throttling.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { mkdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  DEFAULT_WEB_PUSH_PREFERENCES,
  WEB_PUSH_ACTIVITY_NOTIFY_KINDS,
  WEB_PUSH_BODY_MAX,
  WEB_PUSH_FAILURE_KINDS,
  WEB_PUSH_ID_MAX,
  WEB_PUSH_LABEL_MAX,
  WEB_PUSH_TITLE_MAX,
  WEB_PUSH_URGENT_KINDS,
  WEB_PUSH_WIRE_VERSION,
  activityTopicForThread,
  normalizeWebPushPreferences,
  notificationTag,
  type PublicWebPushSubscription,
  type WebPushActivityPhase,
  type WebPushPayload,
  type WebPushPreferences,
  type WebPushSubscriptionInput,
  type WebPushTestResponse,
} from "../shared/web-push.ts";
import { writeFileAtomic } from "./atomic.ts";
import { PUSH_DEVICE_KEY } from "./phone-push.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";
import {
  buildVapidHeaders,
  decodeBase64UrlStrict,
  encryptWebPushPayload,
  generateVapidKeys,
  isValidVapidKeyPair,
  normalizeAuthSecret,
  normalizeP256dhKey,
  type VapidKeyPair,
} from "./web-push-crypto.ts";
import {
  WEB_PUSH_ENDPOINT_MAX,
  WebPushEndpointError,
  isForbiddenWebPushIp,
  resolveAndValidateWebPushEndpoint,
  validateWebPushEndpoint,
} from "./web-push-endpoint.ts";

export {
  WebPushEndpointError,
  isForbiddenWebPushIp,
  resolveAndValidateWebPushEndpoint,
  validateWebPushEndpoint,
};

export const WEB_PUSH_VAPID_FILE = "web-push-vapid.json";
export const WEB_PUSH_SUBSCRIPTIONS_FILE = "web-push-subscriptions.json";
export const DEFAULT_VAPID_SUBJECT = "mailto:notifications@openmausbot.invalid";

export const MAX_WEB_PUSH_SUBSCRIPTIONS = 50;
export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_DEVICE = 4;
export const WEB_PUSH_COALESCE_MS = 10_000;
export const WEB_PUSH_TEST_COOLDOWN_MS = 15_000;
export const WEB_PUSH_ACTIVITY_MIN_INTERVAL_MS = 20_000;
export const WEB_PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const WEB_PUSH_DEVICE_WINDOW_MAX = 30;
export const WEB_PUSH_MAX_AGE_MS = 10 * 60_000;
export const WEB_PUSH_RETRY_MS = [5_000, 30_000, 120_000] as const;
export const WEB_PUSH_FOCUS_TTL_MS = 5 * 60_000;
const WEB_PUSH_TIMEOUT_MS = 10_000;
const PUSH_TTL_SECONDS = 3600;

export const webPushPreferencesSchema = z.object({ enabled: z.boolean().optional(), urgent: z.boolean().optional(), finished: z.boolean().optional(), failures: z.boolean().optional(), mentions: z.boolean().optional(), spend: z.boolean().optional(), liveActivities: z.boolean().optional() }).strict();

export const webPushSubscriptionInputSchema = z.object({
  endpoint: z.string().trim().min(1).max(WEB_PUSH_ENDPOINT_MAX),
  keys: z.object({ p256dh: z.string().trim().min(1).max(200), auth: z.string().trim().min(1).max(64) }).strict(),
  preferences: webPushPreferencesSchema.optional(),
  deviceLabel: z.string().trim().max(WEB_PUSH_LABEL_MAX).optional(),
}).strict().superRefine((value, ctx) => {
  try { validateWebPushEndpoint(value.endpoint); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: e instanceof Error ? e.message : "Invalid endpoint" }); }
  try { normalizeP256dhKey(value.keys.p256dh); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["keys", "p256dh"], message: "Invalid P-256 p256dh key" }); }
  try { normalizeAuthSecret(value.keys.auth); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["keys", "auth"], message: "Invalid 16-byte auth secret" }); }
});

const storedPreferencesSchema = z.object({ enabled: z.boolean(), urgent: z.boolean(), finished: z.boolean(), failures: z.boolean(), mentions: z.boolean(), spend: z.boolean(), liveActivities: z.boolean() }).strict();
const storedSubscriptionSchema = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY), endpoint: z.string().min(1).max(WEB_PUSH_ENDPOINT_MAX),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(64) }).strict(),
  preferences: storedPreferencesSchema, deviceLabel: z.string().max(WEB_PUSH_LABEL_MAX).optional(), createdAt: z.number(), updatedAt: z.number(),
}).strict();
const storedSubscriptionsFileSchema = z.object({ version: z.literal(1), subscriptions: z.array(storedSubscriptionSchema).max(MAX_WEB_PUSH_SUBSCRIPTIONS) });
const storedVapidFileSchema = z.object({ version: z.literal(1), publicKey: z.string().min(1), privateKey: z.string().min(1), createdAt: z.number() });

export type StoredWebPushSubscription = z.infer<typeof storedSubscriptionSchema>;

export interface WebPushTransportRequest {
  url: URL;
  pinnedAddress: LookupAddress;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
}

export interface WebPushTransportResponse {
  status: number;
  retryAfterMs?: number;
}

export type WebPushTransport = (req: WebPushTransportRequest) => Promise<WebPushTransportResponse>;

export interface WebPushNotificationInput {
  id?: string;
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
}

export interface WebPushRoomInfo {
  id: string;
  name: string;
}

export interface WebPushBotState {
  id: string;
  name: string;
  threadId: string;
  busy: boolean;
  hasOpenAsk: boolean;
  askKind?: "approval" | "question" | "sign-in" | "secret";
  group?: WebPushRoomInfo;
}

export interface WebPushOptions {
  dataDir: string;
  subject?: string;
  enabled?: () => boolean;
  /** Live SSE connections per device key (`phoneKey`). */
  liveSseKeys?: () => ReadonlySet<string>;
  /** Unread visible notifications count for badge updates per device key. */
  unreadCount?: (key: string) => number | undefined;
  room?: (notification: WebPushNotificationInput) => WebPushRoomInfo | undefined;
  bot?: (botId: string) => WebPushBotState | undefined;
  botOfThread?: (threadId: string) => string | undefined;
  isAdmin?: (key: string) => boolean;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  transport?: WebPushTransport;
  now?: () => number;
  log?: (line: string) => void;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

type PushOutcome = "sent" | "dropped" | "stale" | "focused" | "gone" | "failed" | "retry" | "paused";

interface QueuedJob {
  slot: string;
  key: string;
  endpoint: string;
  payload: WebPushPayload;
  urgency: "high" | "normal" | "low";
  topic?: string;
  immediate: boolean;
  isActivity: boolean;
  queuedAt: number;
  notBefore: number;
  attempts: number;
}

interface FocusRecord {
  threadId: string;
  updatedAt: number;
}

const SAFE_ID = /^[\w-]{1,120}$/;

const TITLE_KEYS: Readonly<Record<string, ServerLineKey>> = { approval: "server.notify.approval", question: "server.notify.question", "sign-in": "server.notify.signInWebsite", secret: "server.notify.secret", done: "server.notify.done", "turn-failed": "server.notify.turnFailed", "routine-failed": "server.notify.routineFailed", incident: "server.notify.incident", mention: "server.notify.mention", "delegation-settled": "server.notify.delegationSettled", wait: "server.notify.wait" };
const REDACTED_BODY_PHRASES: Readonly<Record<string, string>> = { approval: "Approval requested", question: "Question waiting for reply", "sign-in": "Sign-in requested", secret: "Credential requested", done: "Finished a turn", "turn-failed": "Turn could not finish", "routine-failed": "Routine needs attention", incident: "Bot needs attention", mention: "Mentioned you", spend: "Monthly spend notice", "delegation-settled": "Results ready", wait: "Wait completed", brief: "New brief item" };
const ACTIVITY_PHASE_PHRASES: Readonly<Record<WebPushActivityPhase, string>> = { started: "Started working", working: "Working on task", waiting: "Waiting for your input", done: "Finished working", failed: "Stopped with an error" };

const URGENT_SET = new Set<string>(WEB_PUSH_URGENT_KINDS);
const FAILURE_SET = new Set<string>(WEB_PUSH_FAILURE_KINDS);
const ACTIVITY_NOTIFY_SET = new Set<string>(WEB_PUSH_ACTIVITY_NOTIFY_KINDS);

const ACTIVITY_STAGE_EVENTS = new Set<string>([
  "turn.started",
  "turn.completed",
  "turn.wait_started",
  "turn.wait_ended",
  "request.opened",
  "request.resolved",
  "session.exited",
]);

function clipText(value: string, max: number): string {
  const clean = value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
  const points = [...clean];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

function endpointOriginOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "";
  }
}

export function publicWebPushSubscription(sub: StoredWebPushSubscription): PublicWebPushSubscription {
  return {
    endpoint: sub.endpoint,
    endpointOrigin: endpointOriginOf(sub.endpoint),
    ...(sub.deviceLabel ? { deviceLabel: sub.deviceLabel } : {}),
    preferences: { ...sub.preferences },
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    hasKeys: true,
  };
}

function preferenceEnabledForKind(prefs: WebPushPreferences, kind: string): boolean {
  if (!prefs.enabled) return false;
  if (URGENT_SET.has(kind)) return prefs.urgent;
  if (kind === "done") return prefs.finished;
  if (FAILURE_SET.has(kind)) return prefs.failures;
  if (kind === "mention") return prefs.mentions;
  if (kind === "spend") return prefs.spend;
  if (kind === "activity" || ACTIVITY_NOTIFY_SET.has(kind)) return prefs.liveActivities;
  return false;
}

function buildDeepLink(threadId?: string, botId?: string): string | undefined {
  if (threadId && SAFE_ID.test(threadId)) {
    return `/chat/${encodeURIComponent(threadId)}`;
  }
  if (botId && SAFE_ID.test(botId)) {
    return `/bot/${encodeURIComponent(botId)}`;
  }
  return "/";
}

/**
 * Builds a strictly lock-screen-redacted Web Push payload from IDs, bot/room names, and kind/phase only.
 * Never consumes raw notification text, tool input/output, or secrets.
 */
export function buildRedactedNotificationPayload(
  notification: WebPushNotificationInput,
  options: { id: string; ts: number; room?: WebPushRoomInfo; unreadCount?: number },
): WebPushPayload | null {
  if (!SAFE_ID.test(notification.botId) || !SAFE_ID.test(notification.threadId)) return null;
  if (!REDACTED_BODY_PHRASES[notification.kind]) return null;
  const botName = clipText(notification.botName, 60) || "MausBot";
  const roomName = options.room && SAFE_ID.test(options.room.id) ? clipText(options.room.name, 60) : "";
  const language = conversationLanguage(notification.threadId);
  const who = roomName ? serverLine(language, "server.notify.inRoom", { bot: botName, room: roomName }) : botName;

  let title: string;
  if (notification.kind === "spend") {
    title = `${botName} spend update`;
  } else if (notification.kind === "brief") {
    title = `${botName} brief update`;
  } else if (notification.kind === "secret") {
    // Do not include secret labels on the lock screen.
    title = `${who} needs a credential`;
  } else {
    const key = TITLE_KEYS[notification.kind] ?? "server.notify.done";
    title = serverLine(language, key, { who });
  }

  const isActivityKind = ACTIVITY_NOTIFY_SET.has(notification.kind);
  const kind = notification.kind as WebPushPayload["kind"];
  const topic = isActivityKind ? activityTopicForThread(notification.threadId) : undefined;
  const tag = isActivityKind
    ? notificationTag(notification.threadId, "activity", options.id)
    : notificationTag(notification.threadId, kind, options.id);

  return {
    version: WEB_PUSH_WIRE_VERSION,
    id: options.id,
    kind,
    title: clipText(title, WEB_PUSH_TITLE_MAX),
    body: clipText(REDACTED_BODY_PHRASES[notification.kind]!, WEB_PUSH_BODY_MAX),
    tag,
    ...(topic ? { topic } : {}),
    botId: notification.botId,
    botName,
    threadId: notification.threadId,
    ...(options.room && roomName ? { groupId: options.room.id } : {}),
    ...(options.unreadCount !== undefined ? { unreadCount: options.unreadCount } : {}),
    ts: options.ts,
    url: buildDeepLink(notification.threadId, notification.botId),
  };
}

export function buildRedactedActivityPayload(
  bot: { id: string; name: string; threadId: string; room?: WebPushRoomInfo },
  phase: WebPushActivityPhase,
  options: { id: string; ts: number; unreadCount?: number },
): WebPushPayload | null {
  if (!SAFE_ID.test(bot.id) || !SAFE_ID.test(bot.threadId)) return null;
  const botName = clipText(bot.name, 60) || "MausBot";
  const roomName = bot.room && SAFE_ID.test(bot.room.id) ? clipText(bot.room.name, 60) : "";
  const who = roomName ? `${botName} in ${roomName}` : botName;
  return {
    version: WEB_PUSH_WIRE_VERSION,
    id: options.id,
    kind: "activity",
    title: clipText(who, WEB_PUSH_TITLE_MAX),
    body: ACTIVITY_PHASE_PHRASES[phase],
    tag: notificationTag(bot.threadId, "activity", options.id),
    topic: activityTopicForThread(bot.threadId),
    botId: bot.id,
    botName,
    threadId: bot.threadId,
    ...(bot.room && roomName ? { groupId: bot.room.id } : {}),
    phase,
    ...(options.unreadCount !== undefined ? { unreadCount: options.unreadCount } : {}),
    ts: options.ts,
    url: buildDeepLink(bot.threadId, bot.id),
  };
}

export function httpsWebPushTransport(req: WebPushTransportRequest): Promise<WebPushTransportResponse> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [req.pinnedAddress]);
      else callback(null, req.pinnedAddress.address, req.pinnedAddress.family);
    };
    const request = httpsRequest(
      req.url,
      {
        method: "POST",
        agent: false,
        lookup: pinnedLookup,
        servername: req.url.hostname.replace(/^\[|\]$/g, ""),
        rejectUnauthorized: true,
        timeout: req.timeoutMs,
        headers: {
          ...req.headers,
          "content-length": String(req.body.length),
        },
      },
      (response) => {
        // Drain response without following redirects; redirect status codes are returned directly.
        response.resume();
        const rawRetryAfter = response.headers["retry-after"];
        const retryVal = Array.isArray(rawRetryAfter) ? rawRetryAfter[0] : rawRetryAfter;
        const parsedRetry = Number(retryVal);
        const retryAfterMs = Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry * 1_000 : undefined;
        resolve({
          status: response.statusCode ?? 0,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Web Push request timed out"));
    });
    request.on("error", reject);
    request.end(req.body);
  });
}

function notifyOf(value: unknown): WebPushNotificationInput | null {
  if (!value || typeof value !== "object") return null;
  const { id, kind, botId, botName, threadId, groupId } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof botId !== "string" || typeof botName !== "string" || typeof threadId !== "string") {
    return null;
  }
  return {
    ...(typeof id === "string" && id.length <= WEB_PUSH_ID_MAX ? { id } : {}),
    kind,
    botId,
    botName,
    threadId,
    ...(typeof groupId === "string" ? { groupId } : {}),
  };
}

export class WebPushService {
  private readonly vapidFile: string;
  private readonly subscriptionsFile: string;
  private readonly subject: string;
  private readonly options: WebPushOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly timers: NonNullable<WebPushOptions["timers"]>;
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly transport: WebPushTransport;

  private vapid: VapidKeyPair | null = null;
  private subscriptions: StoredWebPushSubscription[] = [];
  private readonly focusedByKey = new Map<string, FocusRecord>();
  private readonly outbox = new Map<string, QueuedJob>();
  private readonly lastSentBySlot = new Map<string, number>();
  private readonly lastActivityByThread = new Map<string, number>();
  private readonly lastPhaseByThread = new Map<string, WebPushActivityPhase>();
  private readonly sentTimestampsByDevice = new Map<string, number[]>();
  private readonly pausedUntilByOrigin = new Map<string, number>();
  private readonly lastTestByDevice = new Map<string, number>();
  private timer: unknown = null;
  private draining: Promise<void> | null = null;
  private seq = 0;

  constructor(options: WebPushOptions) {
    this.options = options;
    this.vapidFile = join(options.dataDir, WEB_PUSH_VAPID_FILE);
    this.subscriptionsFile = join(options.dataDir, WEB_PUSH_SUBSCRIPTIONS_FILE);
    this.subject = options.subject ?? DEFAULT_VAPID_SUBJECT;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.timers = options.timers ?? {
      set: (run, ms) => setTimeout(run, ms).unref(),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.transport = options.transport ?? httpsWebPushTransport;

    this.loadOrInitVapid();
    this.loadSubscriptions();
  }

  private loadOrInitVapid(): void {
    try {
      const raw = JSON.parse(readFileSync(this.vapidFile, "utf8")) as unknown;
      const parsed = storedVapidFileSchema.safeParse(raw);
      if (parsed.success && isValidVapidKeyPair(parsed.data)) {
        this.vapid = { publicKey: parsed.data.publicKey, privateKey: parsed.data.privateKey };
        return;
      }
      this.log("[web-push] stored VAPID keypair was invalid; regenerating");
    } catch {
      // Missing file on first boot; generate a fresh pair below.
    }
    const fresh = generateVapidKeys();
    this.vapid = fresh;
    mkdirSync(dirname(this.vapidFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.vapidFile, `${JSON.stringify({ version: 1, publicKey: fresh.publicKey, privateKey: fresh.privateKey, createdAt: this.now() }, null, 2)}\n`, { mode: 0o600 });
  }

  private loadSubscriptions(): void {
    try {
      const raw = JSON.parse(readFileSync(this.subscriptionsFile, "utf8")) as unknown;
      const parsed = storedSubscriptionsFileSchema.safeParse(raw);
      if (parsed.success) {
        this.subscriptions = parsed.data.subscriptions.filter((sub) => {
          try {
            validateWebPushEndpoint(sub.endpoint);
            decodeBase64UrlStrict(sub.keys.p256dh, 65);
            decodeBase64UrlStrict(sub.keys.auth, 16);
            return true;
          } catch {
            return false;
          }
        });
      } else {
        this.log("[web-push] saved Web Push subscriptions could not be parsed; devices will re-subscribe");
      }
    } catch {
      // Missing file on first boot.
    }
  }

  private persistSubscriptions(): void {
    mkdirSync(dirname(this.subscriptionsFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.subscriptionsFile, `${JSON.stringify({ version: 1, subscriptions: this.subscriptions }, null, 2)}\n`, { mode: 0o600 });
  }

  isEnabled(): boolean {
    return this.options.enabled ? this.options.enabled() : true;
  }

  vapidPublicKey(): string | null {
    if (!this.isEnabled() || !this.vapid) return null;
    return this.vapid.publicKey;
  }

  getSubscription(key: string, endpoint?: string): PublicWebPushSubscription | null {
    const matches = this.subscriptions.filter((sub) => sub.key === key && (!endpoint || sub.endpoint === endpoint));
    if (!matches.length) return null;
    const latest = matches.reduce((best, item) => (item.updatedAt >= best.updatedAt ? item : best));
    return publicWebPushSubscription(latest);
  }

  listSubscriptions(key: string): PublicWebPushSubscription[] {
    return this.subscriptions
      .filter((sub) => sub.key === key)
      .map(publicWebPushSubscription)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsertSubscription(key: string, input: WebPushSubscriptionInput): Promise<PublicWebPushSubscription> {
    if (!PUSH_DEVICE_KEY.test(key)) {
      throw Object.assign(new Error("Only a paired device can register for Web Push"), { status: 403 });
    }
    const { url } = await resolveAndValidateWebPushEndpoint(input.endpoint, this.lookup);
    const endpoint = url.toString();
    // Validate keys & curve point before storing.
    normalizeP256dhKey(input.keys.p256dh);
    normalizeAuthSecret(input.keys.auth);

    const now = this.now();
    const existingOwn = this.subscriptions.find((sub) => sub.key === key && sub.endpoint === endpoint);
    const otherDevices = this.subscriptions.filter((sub) => sub.endpoint !== endpoint && sub.key !== key);
    const ownOthers = this.subscriptions
      .filter((sub) => sub.key === key && sub.endpoint !== endpoint)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_DEVICE - 1);

    if (!existingOwn && otherDevices.length + ownOthers.length >= MAX_WEB_PUSH_SUBSCRIPTIONS) {
      throw Object.assign(new Error(`At most ${MAX_WEB_PUSH_SUBSCRIPTIONS} Web Push subscriptions are allowed`), { status: 409 });
    }

    const preferences: WebPushPreferences = normalizeWebPushPreferences(
      input.preferences
        ? { ...(existingOwn?.preferences ?? DEFAULT_WEB_PUSH_PREFERENCES), ...input.preferences }
        : existingOwn?.preferences,
    );

    const cleanLabel = input.deviceLabel ? clipText(input.deviceLabel, WEB_PUSH_LABEL_MAX) : existingOwn?.deviceLabel;
    const stored: StoredWebPushSubscription = {
      key,
      endpoint,
      keys: {
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
      },
      preferences,
      ...(cleanLabel ? { deviceLabel: cleanLabel } : {}),
      createdAt: existingOwn?.createdAt ?? now,
      updatedAt: now,
    };

    this.subscriptions = [...otherDevices, ...ownOthers, stored];
    this.persistSubscriptions();
    return publicWebPushSubscription(stored);
  }

  removeSubscription(key: string, endpoint?: string): number {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.key !== key || (endpoint !== undefined && sub.endpoint !== endpoint),
    );
    const removed = before - this.subscriptions.length;
    if (removed > 0) {
      this.persistSubscriptions();
      for (const [slot, job] of this.outbox) {
        if (job.key === key && (!endpoint || job.endpoint === endpoint)) {
          this.outbox.delete(slot);
        }
      }
    }
    return removed;
  }

  forget(key: string): void {
    this.focusedByKey.delete(key);
    this.sentTimestampsByDevice.delete(key);
    this.lastTestByDevice.delete(key);
    this.removeSubscription(key);
  }

  setFocusedThread(key: string, threadId: string | null): void {
    if (!PUSH_DEVICE_KEY.test(key)) return;
    if (!threadId || !SAFE_ID.test(threadId)) {
      this.focusedByKey.delete(key);
      return;
    }
    this.focusedByKey.set(key, { threadId, updatedAt: this.now() });
  }

  /**
   * Suppresses background pushes when the device holds an active SSE stream currently focused on the target thread,
   * avoiding duplicate alerts on the foreground screen.
   */
  isDeviceFocusedOnThread(key: string, threadId: string): boolean {
    const liveSse = this.options.liveSseKeys?.().has(key) ?? false;
    if (!liveSse) return false;
    const focus = this.focusedByKey.get(key);
    if (!focus) return false;
    if (this.now() - focus.updatedAt > WEB_PUSH_FOCUS_TTL_MS) {
      this.focusedByKey.delete(key);
      return false;
    }
    return focus.threadId === threadId;
  }

  offerBroadcast(payload: Record<string, unknown>, reaches: (key: string) => boolean): void {
    try {
      if (!this.subscriptions.length || !this.isEnabled() || !this.vapid) return;
      const frameKind = String(payload.kind ?? "");
      if (frameKind === "notify") {
        this.offerNotifyFrame(payload.notification, reaches);
        return;
      }
      if (frameKind === "bot") {
        const botObj = payload.bot as Record<string, unknown> | undefined;
        const botId = typeof botObj?.id === "string" ? botObj.id : null;
        if (botId) this.offerActivityState(botId, undefined, reaches);
        return;
      }
      if (frameKind === "runtime") {
        const event = payload.event as Record<string, unknown> | undefined;
        const type = typeof event?.type === "string" ? event.type : "";
        const threadId = typeof event?.threadId === "string" ? event.threadId : "";
        if (!ACTIVITY_STAGE_EVENTS.has(type) || !SAFE_ID.test(threadId)) return;
        const botId = this.options.botOfThread?.(threadId);
        if (!botId) return;
        const phaseHint: WebPushActivityPhase | undefined =
          type === "turn.started"
            ? "started"
            : type === "turn.wait_started" || type === "request.opened"
              ? "waiting"
              : type === "turn.wait_ended" || type === "request.resolved"
                ? "working"
                : type === "turn.completed"
                  ? event?.ok === false
                    ? "failed"
                    : "done"
                  : type === "session.exited"
                    ? "done"
                    : undefined;
        this.offerActivityState(botId, phaseHint, reaches, threadId);
      }
    } catch (error) {
      this.log(`[web-push] could not queue push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private offerNotifyFrame(rawNotification: unknown, reaches: (key: string) => boolean): void {
    const notification = notifyOf(rawNotification);
    if (!notification) return;

    const now = this.now();
    const room = this.options.room?.(notification);
    const id = notification.id ?? `wp_${now}_${++this.seq}`;
    const isUrgent = URGENT_SET.has(notification.kind), isFailure = FAILURE_SET.has(notification.kind), isActivityNotify = ACTIVITY_NOTIFY_SET.has(notification.kind), isSpend = notification.kind === "spend";
    const urgency: QueuedJob["urgency"] = isUrgent ? "high" : isActivityNotify ? "low" : "normal", immediate = isUrgent || isFailure || notification.kind === "done";
    for (const sub of this.subscriptions) {
      if ((isSpend && this.options.isAdmin && !this.options.isAdmin(sub.key)) || !preferenceEnabledForKind(sub.preferences, notification.kind) || !reaches(sub.key)) continue;
      if (!isUrgent && this.isDeviceFocusedOnThread(sub.key, notification.threadId)) continue;
      const payload = buildRedactedNotificationPayload(notification, { id, ts: now, room, unreadCount: this.options.unreadCount?.(sub.key) });
      if (!payload) continue;
      this.enqueueJob({ slot: `${sub.key}|${sub.endpoint}|${notification.threadId}|${notification.kind}`, key: sub.key, endpoint: sub.endpoint, payload, urgency, ...(payload.topic ? { topic: payload.topic } : {}), immediate, isActivity: isActivityNotify, queuedAt: now });
    }
    this.kick();
  }

  private offerActivityState(botId: string, phaseHint: WebPushActivityPhase | undefined, reaches: (key: string) => boolean, threadHint?: string): void {
    const bot = this.options.bot?.(botId); if (!bot) return;
    const threadId = threadHint && SAFE_ID.test(threadHint) ? threadHint : bot.threadId;
    const prev = this.lastPhaseByThread.get(threadId);
    const phase: WebPushActivityPhase | undefined = phaseHint ?? (bot.hasOpenAsk ? "waiting" : bot.busy ? (prev ? "working" : "started") : prev && prev !== "done" && prev !== "failed" ? "done" : undefined);
    if (!phase || (prev === phase && phase !== "waiting")) return;
    const now = this.now(), urgent = phase === "done" || phase === "failed" || phase === "waiting";
    if (!urgent && now - (this.lastActivityByThread.get(threadId) ?? -Infinity) < WEB_PUSH_ACTIVITY_MIN_INTERVAL_MS) return;
    this.lastPhaseByThread.set(threadId, phase);
    if (this.lastPhaseByThread.size > 1_000) this.lastPhaseByThread.clear();
    const id = `wp_act_${now}_${++this.seq}`; let enqueued = false;
    for (const sub of this.subscriptions) {
      if (!preferenceEnabledForKind(sub.preferences, "activity") || !reaches(sub.key) || (phase !== "waiting" && this.isDeviceFocusedOnThread(sub.key, threadId))) continue;
      const payload = buildRedactedActivityPayload({ id: bot.id, name: bot.name, threadId, ...(bot.group ? { room: bot.group } : {}) }, phase, { id, ts: now, unreadCount: this.options.unreadCount?.(sub.key) });
      if (!payload) continue;
      this.enqueueJob({ slot: `${sub.key}|${sub.endpoint}|${threadId}|activity`, key: sub.key, endpoint: sub.endpoint, payload, urgency: phase === "waiting" ? "high" : "low", topic: payload.topic, immediate: urgent, isActivity: true, queuedAt: now });
      enqueued = true;
    }
    if (enqueued) { this.lastActivityByThread.set(threadId, now); if (this.lastActivityByThread.size > 1_000) this.lastActivityByThread.clear(); this.kick(); }
  }

  private enqueueJob(job: Omit<QueuedJob, "notBefore" | "attempts">): void {
    const waiting = this.outbox.get(job.slot);
    if (!waiting && !job.immediate) {
      const lastSent = this.lastSentBySlot.get(job.slot) ?? -Infinity;
      if (job.queuedAt - lastSent < WEB_PUSH_COALESCE_MS) return;
    }
    this.outbox.set(job.slot, {
      ...job,
      notBefore: waiting?.notBefore ?? job.queuedAt,
      attempts: waiting?.attempts ?? 0,
    });
  }

  async sendTest(key: string, endpoint?: string): Promise<WebPushTestResponse> {
    if (!this.isEnabled() || !this.vapid) {
      return { ok: false, sent: 0, failed: 0, pruned: 0 };
    }
    const targets = this.subscriptions.filter((sub) => sub.key === key && (!endpoint || sub.endpoint === endpoint));
    if (!targets.length) {
      throw Object.assign(new Error("No Web Push subscription registered for this device"), { status: 404 });
    }
    const now = this.now();
    const lastTest = this.lastTestByDevice.get(key) ?? -Infinity;
    if (now - lastTest < WEB_PUSH_TEST_COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((WEB_PUSH_TEST_COOLDOWN_MS - (now - lastTest)) / 1_000));
      throw Object.assign(new Error("Please wait before sending another test notification"), { status: 429, retryAfterSec });
    }
    let recent = (this.sentTimestampsByDevice.get(key) ?? []).filter((at) => now - at < WEB_PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= WEB_PUSH_DEVICE_WINDOW_MAX) {
      this.sentTimestampsByDevice.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((WEB_PUSH_DEVICE_WINDOW_MS - (now - oldest)) / 1_000));
      throw Object.assign(new Error("Web Push rate limit reached for this device"), { status: 429, retryAfterSec });
    }
    let maxPauseUntil = 0;
    const deliverableTargets = targets.filter((sub) => {
      const pausedUntil = this.pausedUntilByOrigin.get(endpointOriginOf(sub.endpoint)) ?? 0;
      if (pausedUntil > maxPauseUntil) maxPauseUntil = pausedUntil;
      return now >= pausedUntil;
    });
    if (!deliverableTargets.length) {
      const retryAfterSec = Math.max(1, Math.ceil((maxPauseUntil - now) / 1_000));
      throw Object.assign(new Error("Push service temporarily paused due to rate limiting"), { status: 429, retryAfterSec });
    }
    this.lastTestByDevice.set(key, now);
    let sent = 0;
    let failed = targets.length - deliverableTargets.length;
    let pruned = 0;
    for (const sub of deliverableTargets) {
      if (recent.length >= WEB_PUSH_DEVICE_WINDOW_MAX) {
        failed += 1;
        continue;
      }
      const payload: WebPushPayload = {
        version: WEB_PUSH_WIRE_VERSION,
        id: `wp_test_${now}_${++this.seq}`,
        kind: "test",
        title: "OpenMausBot",
        body: "Test notification",
        tag: `omb:test:${sub.key}`,
        ...(this.options.unreadCount ? { unreadCount: this.options.unreadCount(sub.key) } : {}),
        ts: now,
        url: "/",
      };
      const outcome = await this.deliver(sub, payload, "high", undefined, now);
      if (outcome === "sent") {
        sent += 1;
        recent = [...recent, now];
        this.sentTimestampsByDevice.set(key, recent);
      } else if (outcome === "gone") {
        pruned += 1;
      } else {
        failed += 1;
      }
    }
    return { ok: sent > 0 && failed === 0, sent, failed, pruned };
  }

  pending(): number {
    return this.outbox.size;
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (!this.outbox.size) return;
    const due = Math.min(...[...this.outbox.values()].map((job) => job.notBefore));
    if (due <= this.now()) {
      this.kick();
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.kick();
    }, Math.max(due - this.now(), 0));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const now = this.now();
      const job = [...this.outbox.values()].find((candidate) => candidate.notBefore <= now);
      if (!job) return;
      this.outbox.delete(job.slot);

      const outcome = await this.attempt(job, now).catch((error: unknown) => {
        this.log(`[web-push] delivery error: ${error instanceof Error ? error.name : "error"}`);
        return "failed" as const;
      });
      if (outcome === "retry") {
        const delay = WEB_PUSH_RETRY_MS[job.attempts];
        if (delay !== undefined && !this.outbox.has(job.slot)) {
          this.outbox.set(job.slot, {
            ...job,
            attempts: job.attempts + 1,
            notBefore: this.now() + delay,
          });
        }
      } else if (outcome === "paused") {
        const origin = endpointOriginOf(job.endpoint);
        const until = this.pausedUntilByOrigin.get(origin) ?? this.now() + 60_000;
        const delay = WEB_PUSH_RETRY_MS[job.attempts];
        if (delay !== undefined && !this.outbox.has(job.slot)) {
          this.outbox.set(job.slot, {
            ...job,
            attempts: job.attempts + 1,
            notBefore: Math.max(until, this.now() + delay),
          });
        }
      }
    }
  }

  private async attempt(job: QueuedJob, now: number): Promise<PushOutcome> {
    const sub = this.subscriptions.find((candidate) => candidate.key === job.key && candidate.endpoint === job.endpoint);
    if (!sub || !this.isEnabled() || !this.vapid) return "gone";
    if (now - job.queuedAt > WEB_PUSH_MAX_AGE_MS) return "stale";

    const origin = endpointOriginOf(sub.endpoint);
    const pausedUntil = this.pausedUntilByOrigin.get(origin) ?? 0;
    if (now < pausedUntil) {
      this.outbox.set(job.slot, { ...job, notBefore: pausedUntil });
      return "dropped";
    }
    if (job.payload.threadId && job.urgency !== "high" && this.isDeviceFocusedOnThread(sub.key, job.payload.threadId)) return "focused";

    const recent = (this.sentTimestampsByDevice.get(sub.key) ?? []).filter((at) => now - at < WEB_PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= WEB_PUSH_DEVICE_WINDOW_MAX) {
      this.sentTimestampsByDevice.set(sub.key, recent);
      return "dropped";
    }

    const outcome = await this.deliver(sub, job.payload, job.urgency, job.topic, now);
    if (outcome === "sent") {
      this.sentTimestampsByDevice.set(sub.key, [...recent, now]);
      this.lastSentBySlot.set(job.slot, now);
      if (this.lastSentBySlot.size > 2_000) this.lastSentBySlot.clear();
    }
    return outcome;
  }

  private async deliver(sub: StoredWebPushSubscription, payload: WebPushPayload, urgency: "high" | "normal" | "low", topic: string | undefined, now: number): Promise<PushOutcome> {
    if (!this.vapid) return "failed";
    let resolved: { url: URL; address: LookupAddress };
    try {
      resolved = await resolveAndValidateWebPushEndpoint(sub.endpoint, this.lookup);
    } catch {
      this.log("[web-push] blocked push delivery to disallowed endpoint");
      return "failed";
    }

    const { ciphertext } = encryptWebPushPayload({ payload: JSON.stringify(payload), p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    const vapid = buildVapidHeaders({ endpoint: resolved.url.toString(), subject: this.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey, nowSec: Math.floor(now / 1000) });

    let answer: WebPushTransportResponse;
    try {
      answer = await this.transport({
        url: resolved.url,
        pinnedAddress: resolved.address,
        headers: { authorization: vapid.authorization, "content-type": "application/octet-stream", "content-encoding": "aes128gcm", ttl: String(PUSH_TTL_SECONDS), urgency, ...(topic ? { topic } : {}) },
        body: ciphertext,
        timeoutMs: WEB_PUSH_TIMEOUT_MS,
      });
    } catch {
      return "retry";
    }

    if (answer.status >= 200 && answer.status < 300) return "sent";
    if (answer.status === 404 || answer.status === 410) {
      this.subscriptions = this.subscriptions.filter((candidate) => !(candidate.key === sub.key && candidate.endpoint === sub.endpoint));
      this.persistSubscriptions();
      return "gone";
    }
    if (answer.status === 429) {
      const pauseMs = Math.min(Math.max(answer.retryAfterMs ?? 60_000, 1_000), 6 * 60 * 60_000);
      this.pausedUntilByOrigin.set(resolved.url.origin, now + pauseMs);
      return "paused";
    }
    if (answer.status >= 500 || answer.status === 0) return "retry";
    return "failed";
  }
}
