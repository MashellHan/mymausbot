import { describe, expect, it } from "vitest";
import { hasMausUiOptIn, MAUS_MINI_APP_UI_CSS } from "./mini-app-ui-kit.ts";
import { miniAppFrameDocument } from "../src/components/mini-apps/mini-app-document.ts";
import type { MiniAppDocument } from "./mini-apps.ts";

function makeDoc(html: string): MiniAppDocument {
  return {
    app: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "demo",
      title: "Demo",
      description: "Demo app",
      status: "active",
      revision: 1,
      templateVersion: 1,
      publisherBotIds: [],
      createdAt: 1,
      updatedAt: 1,
    },
    html,
    bindings: [],
    versions: [{ version: 1, createdAt: 1, title: "Demo" }],
  };
}

describe("shared/mini-app-ui-kit", () => {
  it("injects MAUS_MINI_APP_UI_CSS only when <meta name=\"maus-ui\" content=\"1\"> is present", () => {
    const optInHtml = '<!doctype html><html><head><meta name="maus-ui" content="1"></head><body><div class="maus-card"></div></body></html>';
    const plainHtml = "<!doctype html><html><body><div>Plain</div></body></html>";

    expect(hasMausUiOptIn(optInHtml)).toBe(true);
    expect(hasMausUiOptIn(plainHtml)).toBe(false);

    const optInFrame = miniAppFrameDocument(makeDoc(optInHtml), false);
    const plainFrame = miniAppFrameDocument(makeDoc(plainHtml), false);

    expect(optInFrame.srcdoc).toContain(".maus-table");
    expect(optInFrame.srcdoc).toContain(".maus-skeleton");
    expect(plainFrame.srcdoc).not.toContain(".maus-table");
    expect(optInFrame.srcdoc).toContain("formatRelativeTime");
    expect(Buffer.byteLength(MAUS_MINI_APP_UI_CSS, "utf8")).toBeLessThan(8 * 1024);
  });
});
