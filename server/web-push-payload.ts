/** Localized, secret-scrubbed Web Push payload builders for notify and live-activity frames. */
import { plainPreviewText } from "../shared/plain-preview.ts";
import {
  WEB_PUSH_ACTIVITY_NOTIFY_KINDS,
  WEB_PUSH_BODY_MAX,
  WEB_PUSH_FAILURE_KINDS,
  WEB_PUSH_ID_MAX,
  WEB_PUSH_TITLE_MAX,
  WEB_PUSH_URGENT_KINDS,
  WEB_PUSH_WIRE_VERSION,
  activityNotificationTag,
  activityTopicForThread,
  notificationTag,
  type WebPushActivityPhase,
  type WebPushPayload,
  type WebPushPreferences,
} from "../shared/web-push.ts";
import { redactSecretsInText } from "./redact.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";

export const SAFE_ID = /^[\w-]{1,120}$/;

const CJK_RE = /[\u3400-\u9FFF]/;

export const URGENT_NOTIFY_SET = new Set<string>(WEB_PUSH_URGENT_KINDS);
export const FAILURE_NOTIFY_SET = new Set<string>(WEB_PUSH_FAILURE_KINDS);
export const ACTIVITY_NOTIFY_SET = new Set<string>(WEB_PUSH_ACTIVITY_NOTIFY_KINDS);

export const ACTIVITY_REPLACING_NOTIFY_KINDS = new Set<string>([
  "done",
  "turn-failed",
  "approval",
  "question",
  "sign-in",
  "secret",
]);

export interface WebPushNotificationInput {
  id?: string;
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
  title?: string;
  body?: string;
}

export interface WebPushRoomInfo {
  id: string;
  name: string;
}

export interface WebPushActivityDetail {
  kind: "tool" | "wait";
  title?: string;
  summary?: string;
  resource?: string;
}

const TITLE_KEYS: Readonly<Record<string, ServerLineKey>> = {
  approval: "server.notify.approval",
  question: "server.notify.question",
  "sign-in": "server.notify.signInWebsite",
  secret: "server.notify.secret",
  done: "server.notify.done",
  "turn-failed": "server.notify.turnFailed",
  "routine-failed": "server.notify.routineFailed",
  incident: "server.notify.incident",
  mention: "server.notify.mention",
  "delegation-settled": "server.notify.delegationSettled",
  wait: "server.notify.wait",
};

const EN_FALLBACK_BODIES: Readonly<Record<string, string>> = {
  approval: "Approval requested",
  question: "Question waiting for reply",
  "sign-in": "Sign-in requested",
  secret: "Credential requested",
  done: "Finished a turn",
  "turn-failed": "Turn could not finish",
  "routine-failed": "Routine needs attention",
  incident: "Bot needs attention",
  mention: "Mentioned you",
  spend: "Monthly spend notice",
  "delegation-settled": "Results ready",
  wait: "Wait completed",
  brief: "New brief item",
};

const ZH_FALLBACK_BODIES: Readonly<Record<string, string>> = {
  approval: "等待你的批准",
  question: "等待你的回复",
  "sign-in": "请打开应用完成登录",
  secret: "请打开应用安全填写",
  done: "已完成本轮回复",
  "turn-failed": "本轮执行未能完成",
  "routine-failed": "例行任务需要关注",
  incident: "需要你的关注",
  mention: "在对话中提到了你",
  spend: "月度费用通知",
  "delegation-settled": "协作结果已返回",
  wait: "等待条件已达成",
  brief: "有新的简报内容",
};

const EN_ACTIVITY_PHRASES: Readonly<Record<WebPushActivityPhase, string>> = {
  started: "Started working",
  working: "Working on task",
  waiting: "Waiting for your input",
  done: "Finished working",
  failed: "Stopped with an error",
};

const ZH_ACTIVITY_PHRASES: Readonly<Record<WebPushActivityPhase, string>> = {
  started: "开始处理任务…",
  working: "正在处理任务…",
  waiting: "等待你的回复",
  done: "已完成",
  failed: "执行出错",
};

export function clipText(value: string, max: number): string {
  const clean = value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
  const points = [...clean];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

export function scrubPushPreview(raw: string | undefined, max = WEB_PUSH_BODY_MAX): string {
  if (!raw) return "";
  const redacted = redactSecretsInText(raw);
  const plain = plainPreviewText(redacted);
  return clipText(plain, max);
}

export function resolvePushLanguage(threadId: string, ...hints: Array<string | undefined>): string {
  const configured = conversationLanguage(threadId);
  if (configured) return configured;
  return hints.some((hint) => Boolean(hint && CJK_RE.test(hint))) ? "zh" : "en";
}

function isChinese(language: string): boolean {
  return language.toLowerCase().startsWith("zh");
}

function formatWho(botName: string, roomName: string, language: string): string {
  if (!roomName) return botName;
  return isChinese(language)
    ? `${botName} · ${roomName}`
    : serverLine(language, "server.notify.inRoom", { bot: botName, room: roomName });
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

function zhTitleForKind(kind: string, who: string, botName: string): string {
  switch (kind) {
    case "approval":
      return `${who} 需要确认`;
    case "question":
      return `${who} 向你提问`;
    case "sign-in":
      return `${who} 需要登录`;
    case "secret":
      return `${who} 需要凭证`;
    case "done":
      return `${who} 已完成`;
    case "turn-failed":
      return `${who} 运行出错`;
    case "routine-failed":
      return `${who} 例行任务出错`;
    case "incident":
      return `${who} 遇到问题`;
    case "mention":
      return `${who} 提到了你`;
    case "spend":
      return `${botName} 费用提醒`;
    case "delegation-settled":
      return `${who} 收到协同结果`;
    case "wait":
      return `${who} 等待已结束`;
    case "brief":
      return `${botName} 简报更新`;
    default:
      return who;
  }
}

function localizedTitleForKind(kind: string, who: string, botName: string, language: string): string {
  if (isChinese(language)) return zhTitleForKind(kind, who, botName);
  if (kind === "spend") return `${botName} spend update`;
  if (kind === "brief") return `${botName} brief update`;
  if (kind === "secret") return `${who} needs a credential`;
  const key = TITLE_KEYS[kind] ?? "server.notify.done";
  return serverLine(language, key, { who });
}

export function activityDetailSignature(detail?: WebPushActivityDetail): string {
  if (!detail) return "";
  if (detail.kind === "tool") {
    const title = scrubPushPreview(detail.title, 48);
    const summary = scrubPushPreview(detail.summary, 90);
    return title || summary ? `tool|${title}|${summary}` : "";
  }
  const resource = scrubPushPreview(detail.resource, 60);
  return `wait|${resource}`;
}

function formatActivityDetail(detail: WebPushActivityDetail, zh: boolean): string {
  if (detail.kind === "tool") {
    const title = scrubPushPreview(detail.title, 48);
    const summary = scrubPushPreview(detail.summary, 90);
    const combined = title && summary && summary !== title ? `${title} · ${summary}` : title || summary;
    if (!combined) return "";
    return clipText(zh ? `正在执行：${combined}` : `Running: ${combined}`, WEB_PUSH_BODY_MAX);
  }
  const resource = scrubPushPreview(detail.resource, 60);
  if (!resource) return zh ? "等待资源可用…" : "Waiting for resource";
  return clipText(zh ? `等待资源：${resource}` : `Waiting for ${resource}`, WEB_PUSH_BODY_MAX);
}

/**
 * Builds a Web Push notification payload with localized titles and secret-scrubbed previews.
 * Security invariant: `secret` notifications are always strictly redacted (never consuming raw title or body);
 * all other kinds scrub secrets via `redactSecretsInText` before stripping Markdown and clipping.
 */
export function buildNotificationPayload(
  notification: WebPushNotificationInput,
  options: { id: string; ts: number; room?: WebPushRoomInfo; unreadCount?: number; replaceActivity?: boolean },
): WebPushPayload | null {
  if (!SAFE_ID.test(notification.botId) || !SAFE_ID.test(notification.threadId)) return null;
  const fallbackEn = EN_FALLBACK_BODIES[notification.kind];
  if (!fallbackEn) return null;

  const botName = clipText(notification.botName, 60) || "MausBot";
  const roomName = options.room && SAFE_ID.test(options.room.id) ? clipText(options.room.name, 60) : "";
  const isSecret = notification.kind === "secret";
  const language = isSecret
    ? resolvePushLanguage(notification.threadId, botName, roomName)
    : resolvePushLanguage(notification.threadId, botName, roomName, notification.title, notification.body);
  const zh = isChinese(language);
  const who = formatWho(botName, roomName, language);

  const previewBody = isSecret ? "" : scrubPushPreview(notification.body, WEB_PUSH_BODY_MAX);
  const fallbackBody = (zh ? ZH_FALLBACK_BODIES[notification.kind] : fallbackEn) ?? fallbackEn;
  const body = previewBody || fallbackBody;

  const title =
    notification.kind === "done" && previewBody
      ? who
      : localizedTitleForKind(notification.kind, who, botName, language);

  const useActivitySlot =
    ACTIVITY_NOTIFY_SET.has(notification.kind) ||
    (Boolean(options.replaceActivity) && ACTIVITY_REPLACING_NOTIFY_KINDS.has(notification.kind));
  const kind = notification.kind as WebPushPayload["kind"];
  const topic = useActivitySlot ? activityTopicForThread(notification.threadId) : undefined;
  const tag = useActivitySlot
    ? activityNotificationTag(notification.threadId)
    : notificationTag(notification.threadId, kind, options.id);

  return {
    version: WEB_PUSH_WIRE_VERSION,
    id: options.id,
    kind,
    title: clipText(title, WEB_PUSH_TITLE_MAX),
    body: clipText(body, WEB_PUSH_BODY_MAX),
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

export const buildRedactedNotificationPayload = buildNotificationPayload;

export function buildActivityPayload(
  bot: { id: string; name: string; threadId: string; room?: WebPushRoomInfo },
  phase: WebPushActivityPhase,
  options: { id: string; ts: number; unreadCount?: number; detail?: WebPushActivityDetail },
): WebPushPayload | null {
  if (!SAFE_ID.test(bot.id) || !SAFE_ID.test(bot.threadId)) return null;
  const botName = clipText(bot.name, 60) || "MausBot";
  const roomName = bot.room && SAFE_ID.test(bot.room.id) ? clipText(bot.room.name, 60) : "";
  const language = resolvePushLanguage(
    bot.threadId,
    botName,
    roomName,
    options.detail?.title,
    options.detail?.summary,
    options.detail?.resource,
  );
  const zh = isChinese(language);
  const who = formatWho(botName, roomName, language);
  const detailText = phase === "working" && options.detail ? formatActivityDetail(options.detail, zh) : "";
  const body = detailText || (zh ? ZH_ACTIVITY_PHRASES[phase] : EN_ACTIVITY_PHRASES[phase]);

  return {
    version: WEB_PUSH_WIRE_VERSION,
    id: options.id,
    kind: "activity",
    title: clipText(who, WEB_PUSH_TITLE_MAX),
    body: clipText(body, WEB_PUSH_BODY_MAX),
    tag: activityNotificationTag(bot.threadId),
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

export const buildRedactedActivityPayload = buildActivityPayload;

export function preferenceEnabledForKind(prefs: WebPushPreferences, kind: string): boolean {
  if (!prefs.enabled) return false;
  if (URGENT_NOTIFY_SET.has(kind)) return prefs.urgent;
  if (kind === "done") return prefs.finished;
  if (FAILURE_NOTIFY_SET.has(kind)) return prefs.failures;
  if (kind === "mention") return prefs.mentions;
  if (kind === "spend") return prefs.spend;
  if (kind === "activity" || ACTIVITY_NOTIFY_SET.has(kind)) return prefs.liveActivities;
  return false;
}

export function notifyOf(value: unknown): WebPushNotificationInput | null {
  if (!value || typeof value !== "object") return null;
  const { id, kind, botId, botName, threadId, groupId, title, body } = value as Record<string, unknown>;
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
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
  };
}

export function parseRuntimeActivityEvent(
  rawEvent: unknown,
): { threadId: string; phase: WebPushActivityPhase; detail?: WebPushActivityDetail } | null {
  if (!rawEvent || typeof rawEvent !== "object") return null;
  const event = rawEvent as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const threadId = typeof event.threadId === "string" ? event.threadId : "";
  if (!SAFE_ID.test(threadId)) return null;
  switch (type) {
    case "turn.started":
      return { threadId, phase: "started" };
    case "turn.wait_started":
      return {
        threadId,
        phase: "working",
        detail: { kind: "wait", ...(typeof event.resource === "string" ? { resource: event.resource } : {}) },
      };
    case "item.started":
      if (event.itemType !== "tool") return null;
      return {
        threadId,
        phase: "working",
        detail: {
          kind: "tool",
          ...(typeof event.title === "string" ? { title: event.title } : {}),
          ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
        },
      };
    case "request.opened":
      return { threadId, phase: "waiting" };
    case "turn.wait_ended":
    case "request.resolved":
      return { threadId, phase: "working" };
    case "turn.completed":
      return { threadId, phase: event.ok === false ? "failed" : "done" };
    case "session.exited":
      return { threadId, phase: "done" };
    default:
      return null;
  }
}

export function buildTestPayload(key: string, id: string, ts: number, unreadCount?: number): WebPushPayload {
  return {
    version: WEB_PUSH_WIRE_VERSION,
    id,
    kind: "test",
    title: "OpenMausBot",
    body: "Test notification",
    tag: `omb:test:${key}`,
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ts,
    url: "/",
  };
}
