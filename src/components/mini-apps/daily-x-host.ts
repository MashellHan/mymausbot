import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";

export { DAILY_X_URL, DAILY_X_FRAME_NAME, dailyXPageAllowed } from "../../../electron/daily-x-frame.mjs";

export const DAILY_X_APP_ID = "5a22c351-114d-4b01-bf2d-216f187ae79b";

export function dailyXHostEligible({ selected, document, state, localOwner, nativeGuard }: {
  selected: MiniAppSummary | null;
  document: MiniAppDocument | null;
  state: MiniAppState | null;
  localOwner: boolean;
  nativeGuard: boolean;
}): boolean {
  return localOwner && nativeGuard && selected?.id === DAILY_X_APP_ID && document?.app.id === DAILY_X_APP_ID
    && state?.appId === DAILY_X_APP_ID && selected.status === "active" && document.app.status === "active" && state.status === "active"
    && selected.shippedTemplateKind === "x_ai_digest" && document.app.shippedTemplateKind === "x_ai_digest"
    && selected.slug === "x-ai-digest" && document.app.slug === "x-ai-digest"
    && selected.revision === document.app.revision && state.revision === document.app.revision
    && selected.templateVersion === document.app.templateVersion && state.templateVersion === document.app.templateVersion
    && !selected.dashboard && !document.app.dashboard && !selected.nativeKind && !document.app.nativeKind;
}
