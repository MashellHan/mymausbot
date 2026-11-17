import zh from "@/locales/zh.json";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";

export const HONGGUO_LOCALE = "zh-CN";

export function hongguoText(key: LocaleKey, params?: Record<string, string | number>): string {
  return t(key, params, zh);
}
