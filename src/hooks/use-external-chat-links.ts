import { useEffect, useState } from "react";
import { postNotificationRead } from "@/components/NotificationsPanel";
import { openChatLink } from "@/components/ThreadRefs";
import { isRemotePwaMode } from "@/lib/pwa-transport";
import { useShowThreads } from "@/lib/thread-preferences";
import { takePwaNotificationTargetFromLocation, takeThreadLinkFromLocation, type PwaNotificationTarget } from "@/lib/thread-refs";
import { SW_NOTIFICATION_CLICK_TYPE } from "@/lib/web-push";
import { openBot, openRoomThread, openThread, type Action, type AppState, type ThreadTarget } from "@/state/store";

function parseNotificationTarget(data: unknown): PwaNotificationTarget | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  const botId = typeof candidate.botId === "string" && candidate.botId ? candidate.botId : undefined;
  const threadId = typeof candidate.threadId === "string" && candidate.threadId ? candidate.threadId : undefined;
  const groupId = typeof candidate.groupId === "string" && candidate.groupId ? candidate.groupId : undefined;
  const notificationId = typeof candidate.notificationId === "string" && candidate.notificationId ? candidate.notificationId : undefined;
  if (!botId && !threadId && !groupId) return null;
  return {
    ...(botId ? { botId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(notificationId ? { notificationId } : {}),
  };
}

export function openPwaNotificationTarget(
  dispatch: (action: Action) => void,
  target: PwaNotificationTarget,
  state: AppState,
  showThreads: boolean,
  onAfterOpen?: () => void,
): void {
  if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
  if (state.settingsOpen) dispatch({ type: "toggleSettings", open: false });
  if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });

  if (target.notificationId) {
    const entry = state.notifications.find((n) => n.id === target.notificationId);
    if (entry && !entry.read) {
      dispatch({ type: "notificationRead", id: entry.id });
      void postNotificationRead(`/api/notifications/${entry.id}/read`, dispatch);
    }
  } else if (target.threadId) {
    const unreadMatches = state.notifications.filter((n) => !n.read && n.threadId === target.threadId);
    for (const entry of unreadMatches) {
      dispatch({ type: "notificationRead", id: entry.id });
      void postNotificationRead(`/api/notifications/${entry.id}/read`, dispatch);
    }
  }

  if (target.groupId) {
    const group = state.groups.find((g) => g.id === target.groupId && !g.dm);
    if (group) {
      openRoomThread(dispatch, { groupId: group.id, threadId: target.threadId }, state.groups);
      if (target.threadId) dispatch({ type: "revealThread", threadId: target.threadId });
      onAfterOpen?.();
      return;
    }
  }

  if (target.threadId) {
    openThread(dispatch, { botId: target.botId ?? "", threadId: target.threadId }, state, showThreads);
    onAfterOpen?.();
    return;
  }

  if (target.botId) {
    const bot = state.bots.find((b) => b.id === target.botId);
    if (bot) {
      openBot(dispatch, bot, showThreads);
    } else {
      dispatch({ type: "notice", notice: { kind: "bot-gone", botName: null } });
    }
    onAfterOpen?.();
  }
}

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => {
    const fromAddress = isRemotePwaMode() ? null : takeThreadLinkFromLocation();
    if (fromAddress) setLink(fromAddress);
    return window.ogb?.onChatLink?.(setLink);
  }, []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
  }, [link, state, showThreads, dispatch]);
}

/** A click on a notification main showed brought this page up, maybe a page just loaded for it. */
export function useDesktopNotificationOpens(state: AppState, dispatch: (action: Action) => void): void {
  const [target, setTarget] = useState<ThreadTarget | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.desktopNotifications?.onOpen(setTarget), []);
  useEffect(() => {
    if (!target || !state.hydrated) return;
    setTarget(null);
    openThread(dispatch, target, state, showThreads);
  }, [target, state, showThreads, dispatch]);
}

/** Deep links opened from a PWA Web Push notification (URL query params at launch or SW `postMessage` while open). */
export function useSwNotificationOpens(
  state: AppState,
  dispatch: (action: Action) => void,
  onAfterOpen?: () => void,
): void {
  const [target, setTarget] = useState<PwaNotificationTarget | null>(null);
  const showThreads = useShowThreads();
  const remotePwa = isRemotePwaMode();

  useEffect(() => {
    if (!remotePwa) return;
    const fromLocation = takePwaNotificationTargetFromLocation();
    if (fromLocation) setTarget(fromLocation);
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !navigator.serviceWorker) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; target?: unknown } | null;
      if (!data || data.type !== SW_NOTIFICATION_CLICK_TYPE) return;
      const parsed = parseNotificationTarget(data.target ?? data);
      if (parsed) setTarget(parsed);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [remotePwa]);

  useEffect(() => {
    if (!target || !state.hydrated) return;
    setTarget(null);
    openPwaNotificationTarget(dispatch, target, state, showThreads, onAfterOpen);
  }, [target, state, showThreads, dispatch, onAfterOpen]);
}
