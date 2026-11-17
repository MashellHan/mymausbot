import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
import { UpdatesRow } from "./AppSettingsRows";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState | null) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } } });
  return renderToStaticMarkup(createElement(UpdatesRow));
}

it("says nothing about updates on a page the desktop app doesn't answer, such as another server's", () => {
  expect(render(null)).toBe("");
});

it("shows this app's update where the desktop app answers, with no Download step", () => {
  expect(render({ status: "idle" })).toContain("Check for updates");
  const downloading = render({ status: "downloading", version: "0.2.0", percent: 40 });
  expect(downloading).toContain("Downloading 40%");
  expect(downloading).toContain("disabled");
  const ready = render({ status: "downloaded", version: "0.2.0" });
  expect(ready).toContain("mymausbot 0.2.0 is ready. Restart the app to apply it.");
  expect(ready).toContain("Restart and install");
  expect(render({ status: "downloaded", version: "0.2.0", installMode: "handoff" })).toContain("mymausbot 0.2.0 is ready. Install it in a terminal.");
});

it("offers the personal manual installer when packaged update metadata is absent or invalid", () => {
  const manualReleaseUrl = "https://github.com/MashellHan/mymausbot/releases";
  const manual = render({ status: "idle", manualReleaseUrl });
  expect(manual).toContain("This installation uses manual updates from mymausbot releases.");
  expect(manual).toContain("Open mymausbot releases");
  const broken = render({ status: "error", manualReleaseUrl, messageCode: "feed", retryable: false });
  expect(broken).toContain("Automatic update setup is unavailable.");
  expect(broken).toContain("Open mymausbot releases");
  expect(broken).not.toContain("Quit and reopen");
});
