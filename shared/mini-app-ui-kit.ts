export const MAUS_UI_META_PATTERN = /<meta\s+name=["']maus-ui["']\s+content=["']1["']\s*\/?>/i;

export const MAUS_MINI_APP_UI_CSS = `
:root {
  --maus-surface-base: var(--surface-base, #ffffff);
  --maus-surface-inset: var(--surface-inset, #f7f7f5);
  --maus-surface-control: var(--surface-control, #f1f1ee);
  --maus-ink: var(--ink, #1c1c1a);
  --maus-ink-secondary: var(--ink-secondary, #63635e);
  --maus-hairline: var(--hairline, rgba(28, 28, 26, 0.1));
  --maus-accent: var(--accent, #0f766e);
  --maus-radius: 10px;
}
:root[data-theme="dark"] {
  --maus-surface-base: var(--surface-base, #171716);
  --maus-surface-inset: var(--surface-inset, #1f1f1d);
  --maus-surface-control: var(--surface-control, #282825);
  --maus-ink: var(--ink, #f4f4f1);
  --maus-ink-secondary: var(--ink-secondary, #a3a39b);
  --maus-hairline: var(--hairline, rgba(255, 255, 255, 0.1));
}
.maus-card {
  background: var(--maus-surface-base);
  border: 1px solid var(--maus-hairline);
  border-radius: var(--maus-radius);
  padding: 14px 16px;
}
.maus-kpi {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.maus-kpi-label {
  font-size: 12px;
  color: var(--maus-ink-secondary);
}
.maus-kpi-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--maus-ink);
  line-height: 1.2;
}
.maus-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.maus-table th,
.maus-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--maus-hairline);
}
.maus-table th {
  font-weight: 500;
  color: var(--maus-ink-secondary);
}
.maus-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--maus-surface-control);
  color: var(--maus-ink);
}
.maus-skeleton {
  background: linear-gradient(90deg, var(--maus-surface-inset) 25%, var(--maus-surface-control) 50%, var(--maus-surface-inset) 75%);
  background-size: 200% 100%;
  border-radius: 6px;
  animation: maus-shimmer 1.4s ease-in-out infinite;
}
@keyframes maus-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.maus-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--maus-ink-secondary);
  font-size: 13px;
}
`.trim();

export function hasMausUiOptIn(html: string): boolean {
  return MAUS_UI_META_PATTERN.test(html);
}

export const MAUS_UI_SDK_HELPERS_SOURCE = `
  base.ui = Object.freeze({
    escapeHtml: function (value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
    formatNumber: function (value, options) {
      var num = Number(value);
      if (!Number.isFinite(num)) return String(value == null ? "" : value);
      try {
        return new Intl.NumberFormat(root.lang || undefined, options).format(num);
      } catch (e) {
        return String(num);
      }
    },
    formatCurrency: function (value, currency) {
      var num = Number(value);
      if (!Number.isFinite(num)) return String(value == null ? "" : value);
      try {
        return new Intl.NumberFormat(root.lang || undefined, { style: "currency", currency: currency || "USD" }).format(num);
      } catch (e) {
        return String(num);
      }
    },
    formatRelativeTime: function (timestampMs) {
      var ts = Number(timestampMs);
      if (!Number.isFinite(ts)) return "";
      var diffSec = Math.round((ts - Date.now()) / 1000);
      var abs = Math.abs(diffSec);
      var unit = abs < 60 ? "second" : abs < 3600 ? "minute" : abs < 86400 ? "hour" : "day";
      var divisor = unit === "second" ? 1 : unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
      try {
        return new Intl.RelativeTimeFormat(root.lang || undefined, { numeric: "auto" }).format(Math.round(diffSec / divisor), unit);
      } catch (e) {
        return new Date(ts).toISOString();
      }
    }
  });
`.trim();
