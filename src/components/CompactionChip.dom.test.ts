// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CompactionChip } from "./DigestChip";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const summary: Message = {
  id: "context", role: "bot", kind: "compaction", at: 1,
  compaction: { summary: "The user wants X.", firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "harness" },
};
const engine: Message = { id: "engine", role: "bot", kind: "compaction", at: 1, engineCompaction: true };
const fresh: Message = { ...summary, compaction: { ...summary.compaction!, summary: "", fresh: true } };

function render(message: Message, onNewChat?: () => void) {
  flushSync(() => root.render(createElement(CompactionChip, { message, onNewChat })));
  return host.querySelector<HTMLElement>("[data-testid=new-chat-hint]");
}

it("keeps automatic/engine compaction quiet in chat while still showing explicit Start fresh dividers", () => {
  for (const message of [summary, engine]) {
    const onNewChat = vi.fn();
    expect(render(message, onNewChat)).toBeNull();
    expect(host.querySelector("[data-testid=compaction-chip]")).toBeNull();
    expect(host.querySelector("[data-testid=engine-compaction-chip]")).toBeNull();
  }
  expect(render(fresh, vi.fn())).toBeNull();
  expect(host.querySelector("[data-testid=fresh-start-divider]")).not.toBeNull();
});
