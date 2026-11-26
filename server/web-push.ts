/** Self-hosted Web Push (RFC 8030 / 8291 / 8292) delivery pipeline, VAPID storage,
 * SSRF-guarded push delivery, localized secret-scrubbed previews, SSE focus dedupe, coalescing and throttling.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  DEFAULT_WEB_PUSH_PREFERENCES,
  WEB_PUSH_LABEL_MAX,
  normalizeWebPushPreferences,
  type PublicWebPushSubscription,
  type WebPushPayload,
  type WebPushPreferences,
  type WebPushSubscriptionInput,
  type WebPushTestResponse,
} from "../shared/web-push.ts";
import { writeFileAtomic } from "./atomic.ts";
import { PUSH_DEVICE_KEY } from "./phone-push.ts";
import { PWA_BRIDGE_CONFIG_FILE, loadPwaBridgeConfig } from "./pwa-bridge-config.ts";
import {
  buildVapidHeaders,
  decodeBase64UrlStrict,
  encryptWebPushPayload,
  generateVapidKeys,
  isValidVapidKeyPair,
  normalizeAuthSecret,
  normalizeP256dhKey,
  validateVapidSubject,
  type VapidKeyPair,
} from "./web-push-crypto.ts";
import {
  WEB_PUSH_ENDPOINT_MAX,
  WebPushEndpointError,
  isForbiddenWebPushIp,
  resolveAndValidateWebPushEndpoint,
  validateWebPushEndpoint,
} from "./web-push-endpoint.ts";
import {
  ACTIVITY_NOTIFY_SET,
  FAILURE_NOTIFY_SET,
  SAFE_ID,
  URGENT_NOTIFY_SET,
  buildActivityPayload,
  buildNotificationPayload,
  buildRedactedActivityPayload,
  buildRedactedNotificationPayload,
  buildTestPayload,
  clipText,
  notifyOf,
  preferenceEnabledForKind,
  type WebPushActivityDetail,
  type WebPushNotificationInput,
  type WebPushRoomInfo,
} from "./web-push-payload.ts";

export {
  WebPushEndpointError,
  buildActivityPayload,
  buildNotificationPayload,
  buildRedactedActivityPayload,
  buildRedactedNotificationPayload,
  isForbiddenWebPushIp,
  resolveAndValidateWebPushEndpoint,
  validateWebPushEndpoint,
  type WebPushActivityDetail,
  type WebPushNotificationInput,
  type WebPushRoomInfo,
};

export const WEB_PUSH_VAPID_FILE = "web-push-vapid.json";
export const WEB_PUSH_SUBSCRIPTIONS_FILE = "web-push-subscriptions.json";
// Apple APNs Web Push rejects RFC 2606 .invalid domains in VAPID sub with HTTP 403 BadJwtToken.
export const DEFAULT_VAPID_SUBJECT = "https://openmausbot.com";

function tryValidVapidSubject(raw: string | undefined, httpsOnly = false): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const validated = validateVapidSubject(trimmed);
    if (httpsOnly && new URL(validated).protocol !== "https:") return null;
    return validated;
  } catch {
    return null;
  }
}

export function defaultVapidSubject(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = tryValidVapidSubject(env.OMB_WEB_PUSH_SUBJECT);
  if (fromEnv) return fromEnv;
  if (existsSync(join(dataDir, PWA_BRIDGE_CONFIG_FILE))) {
    try {
      const fromBridge = tryValidVapidSubject(loadPwaBridgeConfig(dataDir).pwaOrigin, true);
      if (fromBridge) return fromBridge;
    } catch {
      return DEFAULT_VAPID_SUBJECT;
    }
  }
  return DEFAULT_VAPID_SUBJECT;
}

export const MAX_WEB_PUSH_SUBSCRIPTIONS = 50;
export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_DEVICE = 4;
export const WEB_PUSH_COALESCE_MS = 10_000;
export const WEB_PUSH_TEST_COOLDOWN_MS = 15_000;
export const WEB_PUSH_ACTIVITY_MIN_INTERVAL_MS = 20_000;
export const WEB_PUSH_NOTIFY_DEDUPE_MS = 15_000;
export const WEB_PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const WEB_PUSH_DEVICE_WINDOW_MAX = 30;
export const WEB_PUSH_MAX_AGE_MS = 10 * 60_000;
export const WEB_PUSH_RETRY_MS = [5_000, 30_000, 120_000] as const;
export const WEB_PUSH_FOCUS_TTL_MS = 5 * 60_000;
const WEB_PUSH_TIMEOUT_MS = 10_000;
const PUSH_TTL_SECONDS = 3600;
const MAX_SEEN_NOTIFY_IDS = 500;
const MAX_RECENT_NOTIFY_SIGNATURES = 1_000;

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
        headers: { ...req.headers, "content-length": String(req.body.length) },
      },
      (response) => {
        // Drain response without following redirects; redirect status codes are returned directly.
        response.resume();
        const rawRetryAfter = response.headers["retry-after"];
        const retryVal = Array.isArray(rawRetryAfter) ? rawRetryAfter[0] : rawRetryAfter;
        const parsedRetry = Number(retryVal);
        const retryAfterMs = Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry * 1_000 : undefined;
        resolve({ status: response.statusCode ?? 0, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Web Push request timed out")));
    request.on("error", reject);
    request.end(req.body);
  });
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
  private readonly seenNotifyIds = new Set<string>();
  private readonly recentNotifySignatures = new Map<string, number>();
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
    this.subject = options.subject ?? defaultVapidSubject(options.dataDir);
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
    return this.isEnabled() && this.vapid ? this.vapid.publicKey : null;
  }

  getSubscription(key: string, endpoint?: string): PublicWebPushSubscription | null {
    const matches = this.subscriptions.filter((sub) => sub.key === key && (!endpoint || sub.endpoint === endpoint));
    if (!matches.length) return null;
    return publicWebPushSubscription(matches.reduce((best, item) => (item.updatedAt >= best.updatedAt ? item : best)));
  }

  listSubscriptions(key: string): PublicWebPushSubscription[] {
    return this.subscriptions.filter((sub) => sub.key === key).map(publicWebPushSubscription).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsertSubscription(key: string, input: WebPushSubscriptionInput): Promise<PublicWebPushSubscription> {
    if (!PUSH_DEVICE_KEY.test(key)) {
      throw Object.assign(new Error("Only a paired device can register for Web Push"), { status: 403 });
    }
    const { url } = await resolveAndValidateWebPushEndpoint(input.endpoint, this.lookup);
    const endpoint = url.toString();
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
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
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
    this.subscriptions = this.subscriptions.filter((sub) => sub.key !== key || (endpoint !== undefined && sub.endpoint !== endpoint));
    const removed = before - this.subscriptions.length;
    if (removed > 0) {
      this.persistSubscriptions();
      for (const [slot, job] of this.outbox) {
        if (job.key === key && (!endpoint || job.endpoint === endpoint)) this.outbox.delete(slot);
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
    if (!(this.options.liveSseKeys?.().has(key) ?? false)) return false;
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
      if (String(payload.kind ?? "") === "notify") {
        this.offerNotifyFrame(payload.notification, reaches);
      }
    } catch (error) {
      this.log(`[web-push] could not queue push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private hasSeenNotifyId(dedupeKey: string): boolean {
    if (!this.seenNotifyIds.has(dedupeKey)) return false;
    this.seenNotifyIds.delete(dedupeKey);
    this.seenNotifyIds.add(dedupeKey);
    return true;
  }

  private rememberNotifyId(dedupeKey: string): void {
    this.seenNotifyIds.delete(dedupeKey);
    this.seenNotifyIds.add(dedupeKey);
    while (this.seenNotifyIds.size > MAX_SEEN_NOTIFY_IDS) {
      const oldest = this.seenNotifyIds.values().next().value;
      if (oldest === undefined) break;
      this.seenNotifyIds.delete(oldest);
    }
  }

  private rememberNotifySignature(sigKey: string, now: number): void {
    this.recentNotifySignatures.delete(sigKey);
    this.recentNotifySignatures.set(sigKey, now);
    if (this.recentNotifySignatures.size <= MAX_RECENT_NOTIFY_SIGNATURES) return;
    for (const [key, at] of this.recentNotifySignatures) {
      if (now - at >= WEB_PUSH_NOTIFY_DEDUPE_MS) this.recentNotifySignatures.delete(key);
    }
    while (this.recentNotifySignatures.size > MAX_RECENT_NOTIFY_SIGNATURES) {
      const oldest = this.recentNotifySignatures.keys().next().value;
      if (oldest === undefined) break;
      this.recentNotifySignatures.delete(oldest);
    }
  }

  private offerNotifyFrame(rawNotification: unknown, reaches: (key: string) => boolean): void {
    const notification = notifyOf(rawNotification);
    if (!notification) return;

    const now = this.now();
    const room = this.options.room?.(notification);
    const id = notification.id ?? `wp_${now}_${++this.seq}`;
    const isUrgent = URGENT_NOTIFY_SET.has(notification.kind);
    const isFailure = FAILURE_NOTIFY_SET.has(notification.kind);
    const isActivityNotify = ACTIVITY_NOTIFY_SET.has(notification.kind);
    const isSpend = notification.kind === "spend";
    const urgency: QueuedJob["urgency"] = isUrgent ? "high" : isActivityNotify ? "low" : "normal";
    const immediate = isUrgent || isFailure || notification.kind === "done";

    let enqueued = false;
    for (const sub of this.subscriptions) {
      if ((isSpend && this.options.isAdmin && !this.options.isAdmin(sub.key)) || !preferenceEnabledForKind(sub.preferences, notification.kind) || !reaches(sub.key)) continue;
      if (!isUrgent && this.isDeviceFocusedOnThread(sub.key, notification.threadId)) continue;

      const idKey = notification.id ? `${sub.key}|${sub.endpoint}|${notification.id}` : null;
      if (idKey && this.hasSeenNotifyId(idKey)) continue;

      const payload = buildNotificationPayload(notification, {
        id,
        ts: now,
        room,
        unreadCount: this.options.unreadCount?.(sub.key),
      });
      if (!payload) continue;

      const sigKey = `${sub.key}|${sub.endpoint}|${notification.threadId}|${notification.kind}|${payload.body ?? ""}`;
      const prevSigAt = this.recentNotifySignatures.get(sigKey);
      if (prevSigAt !== undefined && now - prevSigAt < WEB_PUSH_NOTIFY_DEDUPE_MS) continue;

      if (idKey) this.rememberNotifyId(idKey);
      this.rememberNotifySignature(sigKey, now);

      this.enqueueJob({
        slot: `${sub.key}|${sub.endpoint}|${notification.threadId}|${notification.kind}`,
        key: sub.key,
        endpoint: sub.endpoint,
        payload,
        urgency,
        ...(payload.topic ? { topic: payload.topic } : {}),
        immediate,
        isActivity: isActivityNotify,
        queuedAt: now,
      });
      enqueued = true;
    }
    if (enqueued) this.kick();
  }

  private enqueueJob(job: Omit<QueuedJob, "notBefore" | "attempts">): void {
    const waiting = this.outbox.get(job.slot);
    if (!waiting && !job.immediate) {
      const lastSent = this.lastSentBySlot.get(job.slot) ?? -Infinity;
      if (job.queuedAt - lastSent < WEB_PUSH_COALESCE_MS) return;
    }
    this.outbox.set(job.slot, { ...job, notBefore: waiting?.notBefore ?? job.queuedAt, attempts: waiting?.attempts ?? 0 });
  }

  async sendTest(key: string, endpoint?: string): Promise<WebPushTestResponse> {
    if (!this.isEnabled() || !this.vapid) return { ok: false, sent: 0, failed: 0, pruned: 0 };
    const targets = this.subscriptions.filter((sub) => sub.key === key && (!endpoint || sub.endpoint === endpoint));
    if (!targets.length) throw Object.assign(new Error("No Web Push subscription registered for this device"), { status: 404 });

    const now = this.now();
    const lastTest = this.lastTestByDevice.get(key) ?? -Infinity;
    if (now - lastTest < WEB_PUSH_TEST_COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((WEB_PUSH_TEST_COOLDOWN_MS - (now - lastTest)) / 1_000));
      throw Object.assign(new Error("Please wait before sending another test notification"), { status: 429, retryAfterSec });
    }
    let recent = (this.sentTimestampsByDevice.get(key) ?? []).filter((at) => now - at < WEB_PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= WEB_PUSH_DEVICE_WINDOW_MAX) {
      this.sentTimestampsByDevice.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((WEB_PUSH_DEVICE_WINDOW_MS - (now - (recent[0] ?? now))) / 1_000));
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
      const payload = buildTestPayload(sub.key, `wp_test_${now}_${++this.seq}`, now, this.options.unreadCount?.(sub.key));
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
      if (outcome === "retry" || outcome === "paused") {
        const delay = WEB_PUSH_RETRY_MS[job.attempts];
        if (delay !== undefined && !this.outbox.has(job.slot)) {
          const until = outcome === "paused" ? this.pausedUntilByOrigin.get(endpointOriginOf(job.endpoint)) ?? this.now() + 60_000 : 0;
          this.outbox.set(job.slot, { ...job, attempts: job.attempts + 1, notBefore: Math.max(until, this.now() + delay) });
        }
      }
    }
  }

  private async attempt(job: QueuedJob, now: number): Promise<PushOutcome> {
    const sub = this.subscriptions.find((candidate) => candidate.key === job.key && candidate.endpoint === job.endpoint);
    if (!sub || !this.isEnabled() || !this.vapid) return "gone";
    if (now - job.queuedAt > WEB_PUSH_MAX_AGE_MS) return "stale";

    const pausedUntil = this.pausedUntilByOrigin.get(endpointOriginOf(sub.endpoint)) ?? 0;
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
    if (answer.status >= 400 && answer.status < 500) {
      this.log(`[web-push] delivery rejected by ${resolved.url.origin} (HTTP ${answer.status})`);
    }
    return "failed";
  }
}
