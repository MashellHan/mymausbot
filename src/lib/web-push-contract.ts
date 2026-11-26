/** Client mirror of the frozen Web Push v1 contract shared with the server. */
import type { NotifyKind } from "../../shared/notification.ts";

export const WEB_PUSH_WIRE_VERSION = 1 as const;

export const WEB_PUSH_VAPID_KEY_ROUTE = "/api/push/web/vapid-key" as const;
export const WEB_PUSH_SUBSCRIPTION_ROUTE = "/api/push/web/subscription" as const;
export const WEB_PUSH_TEST_ROUTE = "/api/push/web/test" as const;

export const WEB_PUSH_ROUTES = {
  vapidKey: WEB_PUSH_VAPID_KEY_ROUTE,
  subscription: WEB_PUSH_SUBSCRIPTION_ROUTE,
  test: WEB_PUSH_TEST_ROUTE,
} as const;

export const WEB_PUSH_ACTIVITY_PHASES = ["started", "working", "waiting", "done", "failed"] as const;
export type WebPushActivityPhase = (typeof WEB_PUSH_ACTIVITY_PHASES)[number];

export const WEB_PUSH_URGENT_KINDS: readonly NotifyKind[] = ["approval", "question", "sign-in", "secret"];
export const WEB_PUSH_FAILURE_KINDS: readonly NotifyKind[] = ["turn-failed", "routine-failed", "incident"];
export const WEB_PUSH_ACTIVITY_NOTIFY_KINDS: readonly NotifyKind[] = ["delegation-settled", "wait", "brief"];

export const WEB_PUSH_ACTIVITY_TAG_PREFIX = "omb:activity:" as const;
export const WEB_PUSH_ID_MAX = 120;
export const WEB_PUSH_LABEL_MAX = 80;
export const WEB_PUSH_TITLE_MAX = 160;
export const WEB_PUSH_BODY_MAX = 140;
/** RFC 8030 §5.4 limits the Topic header to 32 URL-safe base64 characters. */
export const WEB_PUSH_TOPIC_MAX = 32;

export interface WebPushPreferences {
  enabled: boolean;
  /** P0: approval, question, sign-in, secret. */
  urgent: boolean;
  /** P1: done. */
  finished: boolean;
  /** P1: turn-failed, routine-failed, incident. */
  failures: boolean;
  /** P1: mention. */
  mentions: boolean;
  /** P1: spend (admins only). */
  spend: boolean;
  /** P2: thread activity stage updates + delegation-settled, wait, brief. */
  liveActivities: boolean;
}

export const DEFAULT_WEB_PUSH_PREFERENCES: WebPushPreferences = {
  enabled: true,
  urgent: true,
  finished: true,
  failures: true,
  mentions: true,
  spend: true,
  liveActivities: false,
};

export interface WebPushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** PUT /api/push/web/subscription body from an installed PWA or browser. */
export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
  preferences?: Partial<WebPushPreferences>;
  deviceLabel?: string;
}

/** Public view of a stored subscription returned to the owning client; raw keys are omitted. */
export interface PublicWebPushSubscription {
  endpoint: string;
  endpointOrigin: string;
  deviceLabel?: string;
  preferences: WebPushPreferences;
  createdAt: number;
  updatedAt: number;
  hasKeys: true;
}

export interface WebPushVapidKeyResponse {
  enabled: boolean;
  publicKey: string | null;
}

export interface WebPushSubscriptionResponse {
  subscription: PublicWebPushSubscription | null;
  vapidPublicKey: string | null;
}

export interface WebPushTestResponse {
  ok: boolean;
  sent: number;
  failed: number;
  pruned: number;
}

/** Redacted push wire payload delivered inside the RFC 8291 encrypted body to the Service Worker. */
export interface WebPushPayload {
  version: typeof WEB_PUSH_WIRE_VERSION;
  id: string;
  kind: NotifyKind | "activity" | "test";
  title: string;
  body?: string;
  tag: string;
  topic?: string;
  botId?: string;
  botName?: string;
  threadId?: string;
  groupId?: string;
  phase?: WebPushActivityPhase;
  unreadCount?: number;
  ts: number;
  url?: string;
}

export function normalizeWebPushPreferences(
  input?: Partial<WebPushPreferences> | null,
): WebPushPreferences {
  return {
    enabled: input?.enabled ?? DEFAULT_WEB_PUSH_PREFERENCES.enabled,
    urgent: input?.urgent ?? DEFAULT_WEB_PUSH_PREFERENCES.urgent,
    finished: input?.finished ?? DEFAULT_WEB_PUSH_PREFERENCES.finished,
    failures: input?.failures ?? DEFAULT_WEB_PUSH_PREFERENCES.failures,
    mentions: input?.mentions ?? DEFAULT_WEB_PUSH_PREFERENCES.mentions,
    spend: input?.spend ?? DEFAULT_WEB_PUSH_PREFERENCES.spend,
    liveActivities: input?.liveActivities ?? DEFAULT_WEB_PUSH_PREFERENCES.liveActivities,
  };
}

export function activityNotificationTag(threadId: string): string {
  return `${WEB_PUSH_ACTIVITY_TAG_PREFIX}${threadId}`;
}

export function notificationTag(threadId: string | undefined, kind: WebPushPayload["kind"], id: string): string {
  if (kind === "activity" && threadId) return activityNotificationTag(threadId);
  if (threadId) return `omb:${kind}:${threadId}`;
  return `omb:${kind}:${id}`;
}

export function activityTopicForThread(threadId: string): string {
  const safe = threadId.replace(/[^A-Za-z0-9_-]/g, "_");
  const prefixed = `omb_act_${safe}`;
  if (prefixed.length <= WEB_PUSH_TOPIC_MAX) return prefixed;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < threadId.length; i++) {
    const code = threadId.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  const hash = `${h1.toString(36)}${h2.toString(36)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return `omb_act_${safe.slice(0, 11)}_${hash}`.slice(0, WEB_PUSH_TOPIC_MAX);
}
