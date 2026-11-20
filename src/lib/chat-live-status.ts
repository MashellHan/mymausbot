import { useEffect, useMemo, useState } from "react";
import { loadLocalePack, locales, type LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import type { TurnLive } from "@/state/turn-status";
import type { TurnAutomationAction, TurnProgressActivity } from "../../shared/turn-progress";
import { activeLocale } from "./i18n";
import { peerLine } from "./peer-message";

const TOOL_LABEL: Record<TurnProgressActivity, LocaleKey> = {
  write: "chat.activity.writeFile", edit: "chat.activity.editFile", command: "chat.activity.runCommand",
  web: "chat.activity.searchWeb", read: "chat.activity.readFile", fetch: "chat.activity.readPage",
  search: "chat.activity.searching", tool: "chat.activity.usingTool",
};
const AUTOMATION_LABEL: Record<TurnAutomationAction, LocaleKey> = {
  view: "chat.activity.checkingAutomations",
  create: "chat.activity.creatingAutomation",
  update: "chat.activity.updatingAutomation",
  pause: "chat.activity.pausingAutomation",
  resume: "chat.activity.resumingAutomation",
  run_now: "chat.activity.runningAutomation",
  delete: "chat.activity.deletingAutomation",
};

export function chatLiveStatusKey(live: TurnLive): LocaleKey | undefined {
  if (live.ended) return undefined;
  if (live.waiting === "resource") return "chat.activity.waitingForResource";
  if (live.waiting === "retry") return "chat.activity.waitingToRetry";
  const action = live.automation?.at(-1)?.action;
  if (action) return AUTOMATION_LABEL[action];
  if (live.recentAutomation && live.recentAutomation.expiresAt > Date.now()) return AUTOMATION_LABEL[live.recentAutomation.action];
  if (live.status?.activity === "reply") return "chat.activity.reply";
  const tool = live.startedTools?.at(-1);
  if (!tool) return undefined;
  const progress = live.status;
  const activity = progress?.itemId === tool.id ? progress.activity : tool.activity;
  return Object.hasOwn(TOOL_LABEL, activity) ? TOOL_LABEL[activity] : "chat.activity.usingTool";
}

export function useChatLiveStatusKey(live: TurnLive): LocaleKey | undefined {
  const expiresAt = live.automation?.length ? undefined : live.recentAutomation?.expiresAt;
  const [, refresh] = useState(0);
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(() => refresh((count) => count + 1), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return chatLiveStatusKey(live);
}

function messageLanguage(messages: readonly Message[], requestMessageId: string | undefined, app: string): string {
  const message = requestMessageId && messages.find((row) => row.id === requestMessageId);
  if (!message || message.role !== "user" || message.kind !== "text" || message.automated || message.queued || message.reaction ||
      message.relayed || message.aside || message.via === "api" ||
      message.id.startsWith("optimistic-") || peerLine(message)) return app;
  const text = message.text?.replace(/```[\s\S]*?```|`[^`]*`/g, "") ?? "";
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const kana = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hangul = text.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  if (kana || hangul) {
    if (kana && !hangul && kana + han >= latin) return "ja";
    if (hangul && !kana && hangul >= latin) return "ko";
    return app;
  }
  if (han >= 3 && han * 2 >= latin) return app.startsWith("zh") || app === "ja" || app === "ko" ? app : "zh";
  const firstClause = text.trim().split(/[.!?。！？\n]/, 1)[0]!;
  if (han === 0 && /^(?:check|create|update|rename|pause|resume|run|delete)\s+/i.test(firstClause) &&
      /\bautomations?\b/i.test(firstClause)) return "en";
  const english = new Set(text.toLowerCase().match(/\b(?:and|are|can|could|for|is|it|my|please|that|the|this|to|update|when|with|would|you|your)\b/g) ?? []);
  return latin >= 12 && english.size >= 2 ? "en" : app;
}

export function useTurnStatusLanguage(messages: readonly Message[], requestMessageId?: string) {
  const app = activeLocale();
  const language = useMemo(() => messageLanguage(messages, requestMessageId, app), [messages, requestMessageId, app]);
  const pack = locales[language];
  const [, refresh] = useState(0);
  useEffect(() => {
    if (pack) return;
    let active = true;
    void loadLocalePack(language).then((loaded) => {
      if (active && loaded) refresh((count) => count + 1);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [language, pack]);
  return { language, pack };
}
