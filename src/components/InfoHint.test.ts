// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InfoHint } from "./InfoHint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const tip = () => document.querySelector<HTMLElement>("[data-info-hint-content]");

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(InfoHint, { label: "Data coverage", children: "One device is missing." })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("keeps metadata collapsed and reveals it for keyboard users without clipping it inside the panel", async () => {
  const button = host.querySelector("button")!;
  expect(tip()).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async () => button.focus());
  expect(tip()?.textContent).toBe("One device is missing.");
  expect(tip()?.parentElement).toBe(document.body);
  expect(button.getAttribute("aria-describedby")).toBe(tip()?.id);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(tip()).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("allows hovering into the details, pinning by click and dismissing outside", async () => {
  vi.useFakeTimers();
  const button = host.querySelector("button")!;
  await act(async () => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(tip()).not.toBeNull();
  await act(async () => button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  await act(async () => tip()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await act(async () => { vi.advanceTimersByTime(150); });
  expect(tip()).not.toBeNull();
  await act(async () => button.click());
  await act(async () => tip()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  await act(async () => { vi.advanceTimersByTime(150); });
  expect(tip()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(tip()).toBeNull();
  await act(async () => button.click());
  expect(tip()).not.toBeNull();
  await act(async () => button.click());
  expect(tip()).toBeNull();
});
