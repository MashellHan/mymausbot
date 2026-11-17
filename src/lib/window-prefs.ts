// The window's own preferences, as the server's app_settings tool reaches them: a `window-pref` frame is applied with
// the preference's setter, and every setter reports the current values back so a bot can read them.
import { WINDOW_PREFS, type WindowPrefFrame, type WindowPrefId } from "../../shared/app-settings";
import { applyChatWidth, readChatWidth } from "./chat-width";
import { applyFont, readFont } from "./fonts";
import { readInterfaceMode, setInterfaceMode } from "./interface-mode";
import { notificationSoundsEnabled, setNotificationSounds } from "./notification-preferences";
import { readSendKey, setSendKey } from "./send-key";
import { applySkinChoice, readSkinChoice } from "./skins";
import { readShowThreadsChoice, setShowThreads } from "./thread-preferences";
import { onWindowPrefChanged } from "./window-pref-changes";

const PREFS: Record<WindowPrefId, { read(): unknown; write(value: never): void }> = {
  "appearance.skin": { read: () => readSkinChoice(), write: (choice) => applySkinChoice(choice) },
  "appearance.mode": { read: () => readInterfaceMode(), write: (mode) => setInterfaceMode(mode) },
  "appearance.font": { read: () => readFont(), write: (font) => applyFont(font) },
  "appearance.chatWidth": { read: () => readChatWidth(), write: (width) => applyChatWidth(width) },
  "appearance.showThreads": { read: () => readShowThreadsChoice(), write: (shown) => setShowThreads(shown) },
  "general.sendKey": { read: () => readSendKey(), write: (key) => setSendKey(key) },
  "general.notificationSounds": { read: () => notificationSoundsEnabled(), write: (on) => setNotificationSounds(on) },
};

export function applyWindowPref(frame: WindowPrefFrame): void {
  const schema = WINDOW_PREFS[frame.id];
  const parsed = schema?.safeParse(frame.value);
  if (!parsed?.success) return;
  PREFS[frame.id].write(parsed.data as never);
}

export function windowPrefValues(): Record<WindowPrefId, unknown> {
  return Object.fromEntries((Object.keys(PREFS) as WindowPrefId[]).map((id) => [id, PREFS[id].read()])) as Record<WindowPrefId, unknown>;
}

let report: ReturnType<typeof setTimeout> | null = null;
/** Tells the server the window's values, once the burst of setters at start-up has settled. */
export function reportWindowPrefs(): void {
  if (typeof fetch !== "function" || typeof window === "undefined") return;
  if (report) clearTimeout(report);
  report = setTimeout(() => {
    report = null;
    fetch("/api/window-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: windowPrefValues() }) }).catch(() => undefined);
  }, 200);
}

onWindowPrefChanged(reportWindowPrefs);
