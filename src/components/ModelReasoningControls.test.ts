import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return { instances: [] as InstanceInfo[], modelVariantSessions: {}, dispatch: vi.fn() };
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [], modelVariantSessions: fixture.modelVariantSessions },
    dispatch: fixture.dispatch,
  }),
}));

const { EffortRow } = await import("./ModelReasoningControls");

afterAll(() => vi.unstubAllGlobals());

function bot(effort?: Bot["modelSelection"]["effort"]): Bot {
  return {
    id: "atlas",
    threadId: "thread-1",
    name: "Atlas",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.6", ...(effort ? { effort } : {}) },
    messages: [],
  };
}

beforeEach(() => {
  fixture.instances = [];
  fixture.dispatch.mockReset();
});

describe("EffortRow when no effort levels are available", () => {
  it("returns nothing when effort is unset", () => {
    expect(renderToStaticMarkup(createElement(EffortRow, { bot: bot(), compact: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(EffortRow, { bot: bot(), compact: false }))).toBe("");
  });

  it("renders a read-only badge instead of a destructive Default select/button when effort is set", () => {
    for (const compact of [true, false]) {
      const html = renderToStaticMarkup(createElement(EffortRow, {
        bot: bot("high"),
        compact,
        label: createElement("span", null, "Reasoning"),
      }));
      expect(html).not.toContain("<select");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("Default");
      expect(html).toContain('data-effort-readonly=""');
      expect(html).toContain("High");
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the interactive select when levels are available even if current effort is unavailable", () => {
    fixture.instances = [{
      instanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      snapshot: { state: "available", version: "1.0.0" },
      models: { default: "gpt-5.6", options: [{ id: "gpt-5.6", label: "GPT-5.6" }] },
      capabilities: { effortLevels: ["low", "medium"] },
    }];
    const html = renderToStaticMarkup(createElement(EffortRow, { bot: bot("high"), compact: true }));
    expect(html).toContain("<select");
    expect(html).toContain("High (unavailable)");
    expect(html).toContain("Low");
    expect(html).toContain("Medium");
  });
});
