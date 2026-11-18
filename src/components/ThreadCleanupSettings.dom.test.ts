// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  threads: { maxConcurrentPerBot: 3, eventLogRetentionDays: 14, eventLogMaxBytes: 52428800 },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: { threads: fixture.threads } }, dispatch: vi.fn() }),
}));

let host: HTMLDivElement;
let root: Root;
const type = (id: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
  flushSync(() => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
};
const rowOfAlert = () => {
  const row = host.querySelector('[role="alert"]')?.closest('[role="group"]');
  return row ? document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.threads.eventLogMaxBytes = 52428800;
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(ThreadCleanupSettings)));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("ThreadCleanupSettings errors", () => {
  it("keeps an exact byte cap when the rounded MiB input is focused and blurred without an edit", () => {
    fixture.threads.eventLogMaxBytes = 1048577;
    flushSync(() => root.render(createElement(ThreadCleanupSettings)));
    const field = host.querySelector<HTMLInputElement>("#thread-log-cap-mib")!;
    expect(field.value).toBe("1");
    flushSync(() => field.focus());
    flushSync(() => field.blur());
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.threads.eventLogMaxBytes).toBe(1048577);
  });

  it("shows an invalid retention under the retention row", () => {
    type("thread-log-retention-days", "0");
    expect(rowOfAlert()).toBe("Delete old event logs");
  });

  it("shows a failed retention save under the retention row", async () => {
    fixture.api.mockRejectedValue(new Error("Disk is read-only"));
    type("thread-log-retention-days", "30");
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Disk is read-only"));
    expect(rowOfAlert()).toBe("Delete old event logs");
  });
});
