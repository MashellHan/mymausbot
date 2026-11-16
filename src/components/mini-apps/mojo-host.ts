import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";

export const MOJO_APP_ID = "01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7";
export { MOJO_POETRY_URL, MOJO_POETRY_FRAME_NAME } from "../../../electron/mojo-poetry-frame.mjs";
const QUOTES_MARKER = '<meta name="openmausbot:mojo-view" content="quotes-v1">';

export function mojoHostEligible(input: {
  selected: MiniAppSummary | null;
  document: MiniAppDocument | null;
  state: MiniAppState | null;
  localOwner: boolean;
  nativeGuard: boolean;
}): boolean {
  const { selected, document, state, localOwner, nativeGuard } = input;
  if (!localOwner || !nativeGuard || selected?.id !== MOJO_APP_ID || document?.app.id !== MOJO_APP_ID
    || state?.appId !== MOJO_APP_ID || selected.status !== "active" || document.app.status !== "active" || state.status !== "active"
    || selected.revision !== document.app.revision || state.revision !== document.app.revision
    || selected.templateVersion !== document.app.templateVersion || state.templateVersion !== document.app.templateVersion
    || document.bindings.length !== 0 || state.data.length !== 0) return false;
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(document.html)?.[1];
  return head?.split(QUOTES_MARKER).length === 2;
}
