// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import { BotEditorStore, initialState } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { SectionPicker } from "./SidebarSectionPicker";

let host: HTMLDivElement;
let root: Root;
let state: AppState;
const onAssign = vi.fn();
const onClose = vi.fn();
const value = () => ({ state, dispatch: vi.fn(), flushBotPatches: async () => null,
  refreshInstances: async () => {}, refreshModels: async () => {} });
const mount = async (anchor = { x: 100, y: 120 }, current = "Ops 20") => {
  await act(async () => root.render(createElement(BotEditorStore, { value: value(),
    children: createElement(SectionPicker, { current, anchor, onAssign, onClose }),
  })));
};
const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Search or create department"]')!;
const options = () => [...host.querySelectorAll<HTMLButtonElement>('[data-section-picker] [role="group"] button')];
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  setLocale("en");
  onAssign.mockClear();
  onClose.mockClear();
  state = { ...initialState, sections: Array.from({ length: 40 }, (_, index) => `Ops ${index}`), bots: [], groups: [] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("department picker", () => {
  it("bounds a long department list and searches without changing canonical membership names", async () => {
    await mount();
    expect(options()).toHaveLength(40);
    const list = host.querySelector<HTMLElement>('[data-section-picker] [role="group"]')!;
    expect(list.className).toContain("max-h-52");
    expect(list.className).toContain("overflow-y-auto");
    expect(document.activeElement).toBe(input());

    await type("ops 20");
    expect(options().map((button) => button.textContent?.trim())).toEqual(["Ops 20"]);
    expect(host.querySelector("form button")?.textContent).toBe("Move");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onAssign).toHaveBeenCalledWith("Ops 20");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps creation and explicit removal as department membership actions", async () => {
    await mount();
    await type("North");
    expect(options()).toHaveLength(0);
    expect(host.textContent).toContain("No matching departments");
    expect(host.querySelector("form button")?.textContent).toBe("Create & move");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onAssign).toHaveBeenCalledWith("North");
    const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Remove from department")!;
    await act(async () => remove.click());
    expect(onAssign).toHaveBeenLastCalledWith("");
  });

  it.each([
    { sections: ["Work", "work"], target: "work" },
    { sections: ["work", "Work"], target: "Work" },
  ])("preserves the exact department $target regardless of stored order", async ({ sections, target }) => {
    state = { ...state, sections };
    await mount();
    await type(target);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onAssign).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("requires an explicit option for an ambiguous folded name", async () => {
    state = { ...state, sections: ["Work", "work"] };
    await mount();
    await type("WORK");
    expect(host.querySelector<HTMLButtonElement>("form button")!.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("More than one department matches. Choose one below.");
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="status"]')!.id);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onAssign).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => options().find((button) => button.textContent?.trim() === "work")!.click());
    expect(onAssign).toHaveBeenCalledExactlyOnceWith("work");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays inside a short viewport with a scrollable menu", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 280 });
    await mount({ x: 100, y: 250 });
    const menu = host.querySelector<HTMLElement>("[data-section-picker]")!;
    expect(menu.style.top).toBe("8px");
    expect(menu.className).toContain("max-h-[calc(100dvh-16px)]");
    expect(menu.className).toContain("overflow-y-auto");
  });
});
