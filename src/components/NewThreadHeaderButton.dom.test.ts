// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store-select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store-select")>()),
  useStoreDispatch: () => fixture.dispatch,
}));

import { NewThreadHeaderButton } from "./NewThreadHeaderButton";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("NewThreadHeaderButton", () => {
  it("renders a 32px accessible button and dispatches newTask for the bot", () => {
    flushSync(() => root.render(createElement(NewThreadHeaderButton, { botId: "atlas" })));
    const button = host.querySelector<HTMLButtonElement>("[data-new-thread]")!;
    expect(button).not.toBeNull();
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["size-8", "rounded-full"]));
    expect(button.getAttribute("aria-label")).toBe("New thread");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+T Control+T");
    expect(button.title).toBe("New thread");
    button.focus();
    expect(document.activeElement).toBe(button);
    flushSync(() => button.click());
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "newTask", botId: "atlas" });
  });
});
