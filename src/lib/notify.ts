import type { Notification } from "../../shared/notification";
import { plainPreviewText } from "../../shared/plain-preview";
import { finishedNotificationsEnabled, notificationSoundsEnabled } from "./notification-preferences";
import { getWebPushClientSnapshot, isStandalonePwa } from "./web-push";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** On a team's page in the desktop app, its name: notifications then say which place they come from ("Acme · Scout"). */
let placeName: string | null = null;
export function setNotificationPlace(name: string | null) {
  placeName = name;
}

/** Call from the click: browsers may reject a permission request made later from an SSE frame. Resolves to the permission now in force. */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  } catch {
    return Notification.permission;
  }
}

export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

function buildDeepLinkUrl(frame: NotifyFrame): string {
  const params = new URLSearchParams();
  if (frame.botId) params.set("bot", frame.botId);
  if (frame.groupId) params.set("group", frame.groupId);
  if (frame.threadId) params.set("thread", frame.threadId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

async function showViaServiceWorker(title: string, options: NotificationOptions, frame: NotifyFrame): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !navigator.serviceWorker) return false;
  const sw = navigator.serviceWorker;
  try {
    const registration = (typeof sw.getRegistration === "function" ? await sw.getRegistration() : undefined) ?? (await sw.ready);
    if (!registration || typeof registration.showNotification !== "function") return false;
    await registration.showNotification(title, {
      ...options,
      data: {
        botId: frame.botId,
        threadId: frame.threadId,
        ...(frame.groupId ? { groupId: frame.groupId } : {}),
        kind: frame.kind,
        url: buildDeepLinkUrl(frame),
      },
    });
    return true;
  } catch {
    return false;
  }
}

function webPushHandlesKind(kind: NotifyFrame["kind"]): boolean {
  const prefs = getWebPushClientSnapshot().subscription?.preferences;
  if (!prefs?.enabled) return false;
  switch (kind) {
    case "approval":
    case "question":
    case "sign-in":
    case "secret":
      return prefs.urgent;
    case "done":
      return prefs.finished;
    case "turn-failed":
    case "routine-failed":
    case "incident":
      return prefs.failures;
    case "mention":
      return prefs.mentions;
    case "spend":
      return prefs.spend;
    case "delegation-settled":
    case "wait":
    case "brief":
      return prefs.liveActivities;
    default:
      return false;
  }
}

export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  const hasNotificationGlobal = typeof Notification !== "undefined";
  const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator && Boolean(navigator.serviceWorker);
  if (!hasNotificationGlobal && !(isStandalonePwa() && hasServiceWorker)) return;
  if (frame.kind === "done" && !finishedNotificationsEnabled()) return;
  const spend = frame.kind === "spend";
  if (!spend && document.hasFocus() && visibleThreadId === frame.threadId) return;
  if (hasNotificationGlobal && Notification.permission !== "granted") return;

  const title = placeName ? `${placeName} · ${frame.title}` : frame.title;
  // Entries saved before the harness spoke plain text still carry Markdown.
  const body = plainPreviewText(frame.body);
  const options: NotificationOptions = {
    body,
    ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
    ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
    ...(notificationSoundsEnabled() ? {} : { silent: true }),
  };
  const shownByPage = () => {
    // When this standalone PWA has an active Web Push subscription for this kind, the server pushes it via sw.js.
    if (isStandalonePwa() && webPushHandlesKind(frame.kind)) return;
    // iOS standalone PWAs expose Notification.permission but throw if new Notification() is called instead of SW showNotification().
    if ((!hasNotificationGlobal || isStandalonePwa()) && hasServiceWorker) {
      void showViaServiceWorker(title, options, frame);
      return;
    }
    try {
      new Notification(title, options).onclick = () => {
        window.focus();
        onOpen({ botId: frame.botId, threadId: frame.threadId });
      };
    } catch {
      if (hasServiceWorker) {
        void showViaServiceWorker(title, options, frame);
      }
    }
  };
  const desktop = window.ogb?.desktopNotifications;
  if (!desktop) return shownByPage();
  void desktop.show({
    title, body, tag: options.tag, silent: options.silent === true, picture: options.icon, botId: frame.botId, threadId: frame.threadId,
  }).then((shown) => { if (!shown) shownByPage(); }, shownByPage);
}
