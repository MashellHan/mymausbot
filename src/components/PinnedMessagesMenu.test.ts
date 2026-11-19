import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

function topBar(text: string): string {
  const start = text.indexOf('<GlassBar edge="top"');
  const end = text.indexOf("</GlassBar>", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

it("keeps the pinned message out of the strip above both transcripts", () => {
  const chat = source("ChatView.tsx");
  const group = source("GroupView.tsx");
  for (const transcript of [chat, group]) expect(transcript).not.toContain("chat.pinnedJump");

  const chatHeader = topBar(chat);
  const controls = chatHeader.indexOf("data-chathead-controls");
  expect(controls).toBeGreaterThanOrEqual(0);
  expect(chatHeader.slice(controls)).toContain("<PinnedMessagesMenu");
  expect(chat.match(/<PinnedMessagesMenu\b/g)).toHaveLength(1);
  expect(chat.indexOf("data-chat-transcript-scroll")).toBeGreaterThan(chat.indexOf("</GlassBar>"));

  expect(topBar(group)).toContain("<RoomHeader");
  expect(group.indexOf("ref={transcriptRef}")).toBeGreaterThan(group.indexOf("</GlassBar>"));
  expect(group).not.toContain("<PinnedMessagesMenu");
  const roomHeader = source("RoomHeader.tsx");
  expect(roomHeader).toMatch(/const pinned = \([\s\S]*?<PinnedMessagesMenu\b/);
  const roomControls = roomHeader.split("data-roomhead-controls").slice(1);
  expect(roomControls).toHaveLength(2);
  for (const row of roomControls) expect(row).toContain("{pinned}");
});
