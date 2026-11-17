import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
import { useUpdateItem } from "./SidebarProfileMenu";

afterEach(() => vi.unstubAllGlobals());
function entry(state: UpdaterState | null) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() }, openExternal: vi.fn() } });
  let result: ReturnType<typeof useUpdateItem> = null;
  renderToStaticMarkup(createElement(() => { result = useUpdateItem(); return null; }));
  return result as ReturnType<typeof useUpdateItem>;
}

it("offers no update entry on a page the desktop app doesn't answer, such as another server's", () => {
  expect(entry(null)).toBeNull();
});

it("offers the restart once an update has downloaded by itself", () => {
  expect(entry({ status: "idle" })?.label).toBe("Check for updates");
  const ready = entry({ status: "downloaded", version: "0.2.0" });
  expect(ready?.label).toBe("Restart to update to mymausbot 0.2.0");
  expect(ready?.item.attention).toBe(true);
});

it("opens only the personal releases for a local manual install, without retrying its absent feed", () => {
  const manual = entry({ status: "idle", manualReleaseUrl: "https://github.com/MashellHan/mymausbot/releases" });
  expect(manual?.label).toBe("Get updates from mymausbot releases");
  expect(manual?.item.disabled).toBe(false);
  manual?.item.onSelect?.();
  expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://github.com/MashellHan/mymausbot/releases");
  expect(window.ogb?.updater?.check).not.toHaveBeenCalled();

  const broken = entry({ status: "error", manualReleaseUrl: "https://github.com/MashellHan/mymausbot/releases", retryable: false, messageCode: "feed" });
  expect(broken?.label).toBe("Update setup unavailable · open releases");
  expect(broken?.item.attention).toBe(true);
  expect(broken?.item.disabled).toBe(false);
  broken?.item.onSelect?.();
  expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://github.com/MashellHan/mymausbot/releases");
  expect(window.ogb?.updater?.check).not.toHaveBeenCalled();
});
