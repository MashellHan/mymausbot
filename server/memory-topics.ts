// A memory/<topic>.md may begin with YAML frontmatter: `title`, `description`, `aliases`, `links`, `entities`, `updated`.
import { closeSync, openSync, readSync } from "node:fs";

import { hasCjk } from "./cjk-search.ts";

const HEAD_BYTES = 2_048;
export const TOPIC_INDEX_MAX_TOPICS = 40;
export const TOPIC_INDEX_MAX_CHARS = 2_000;
export const TOPIC_MAX_LINKS = 8;
export const TOPIC_MAX_ENTITIES = 12;

export interface TopicHeader {
  title?: string;
  description?: string;
  aliases: string[];
  links?: string[];
  entities?: string[];
  updated?: string;
}

export function normalizeTopicSlug(raw: string): string | null {
  const slug = raw
    .trim()
    .replace(/^memory\//i, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!slug || slug === "archive" || slug === "memory") return null;
  return slug;
}

export function extractInlineWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^[\]\r\n|]{1,64})(?:\|[^[\]\r\n]*)?\]\]/g)) {
    const slug = normalizeTopicSlug(match[1]!);
    if (slug && !out.includes(slug)) out.push(slug);
    if (out.length >= TOPIC_MAX_LINKS * 2) break;
  }
  return out;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).trim();
  return v;
}

export function parseTopicHeader(text: string): TopicHeader {
  const header: TopicHeader = { aliases: [] };
  const lead = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/.exec(text)?.[0] ?? "";
  const heading = /^#{1,6}[ \t]+([^\r\n]+)/m.exec(lead)?.[1]?.trim();
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(lead.length));
  if (!m) {
    if (heading) header.title = heading.slice(0, 160);
    return header;
  }
  const links: string[] = [];
  const entities: string[] = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const field = /^(title|description|aliases|tags|links|entities|updated)\s*:\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "title" || key === "description" || key === "updated") {
      if (value.trim()) header[key] = unquote(value).slice(0, key === "updated" ? 16 : 160);
      continue;
    }
    const items: string[] = [];
    if (value.trim().startsWith("[")) {
      items.push(...value.trim().replace(/^\[|\]$/g, "").split(","));
    } else if (value.trim()) {
      items.push(...value.split(","));
    } else {
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[(i += 1)].replace(/^\s*-\s+/, ""));
    }
    for (const item of items.map(unquote).filter(Boolean)) {
      if (key === "links") {
        const slug = normalizeTopicSlug(item);
        if (slug && !links.includes(slug)) links.push(slug);
      } else if (key === "entities") {
        const clean = item.slice(0, 60);
        if (!entities.includes(clean)) entities.push(clean);
      } else if (!header.aliases.includes(item)) {
        header.aliases.push(item.slice(0, 40));
      }
    }
  }
  header.aliases = header.aliases.slice(0, 12);
  if (links.length) header.links = links.slice(0, TOPIC_MAX_LINKS);
  if (entities.length) header.entities = entities.slice(0, TOPIC_MAX_ENTITIES);
  if (!header.title && heading) header.title = heading.slice(0, 160);
  return header;
}

export function topicWords(name: string, header: TopicHeader): string[] {
  const text = [
    name.replace(/\.md$/i, "").replace(/[-_.]+/g, " "),
    header.title ?? "",
    header.description ?? "",
    ...header.aliases,
    ...(header.entities ?? []),
  ].join(" ");
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= (hasCjk(word) ? 2 : 3)))];
}

export function topicBody(text: string): string {
  const lead = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/.exec(text)?.[0] ?? "";
  const rest = text.slice(lead.length).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return rest.trim();
}

export function readTopicHead(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function renderTopicIndex(topics: ReadonlyArray<{ name: string; header: TopicHeader }>): string {
  if (!topics.length) return "";
  const ordered = [...topics].sort((a, b) => Number(a.name === "archive.md") - Number(b.name === "archive.md") || a.name.localeCompare(b.name));
  const lines: string[] = [];
  let length = 0;
  let omitted = 0;
  for (const { name, header } of ordered) {
    if (lines.length >= TOPIC_INDEX_MAX_TOPICS) {
      omitted += 1;
      continue;
    }
    const about = name === "archive.md"
      ? "older notes moved out of MEMORY.md, kept for the record"
      : [header.title, header.description].filter(Boolean).join(" — ");
    const also = header.aliases.length ? ` (also: ${header.aliases.join(", ")})` : "";
    const line = `- memory/${name}${about ? ` — ${about}` : ""}${also}`.replace(/\s+/g, " ");
    if (length + line.length + 1 > TOPIC_INDEX_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (omitted) lines.push(`- …and ${omitted} more in memory/`);
  return lines.join("\n");
}

const LEAD = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/;
const HEADER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function aliasList(aliases: readonly string[]): string {
  return `[${aliases.join(", ")}]`;
}

export function mergeTopicText(
  existing: string | null,
  input: { title: string; aliases: readonly string[]; links?: readonly string[]; entities?: readonly string[]; updated?: string; lines: readonly string[] },
): string {
  const lines = input.lines.join("\n");
  const normalizedLinks = [...new Set((input.links ?? []).map(normalizeTopicSlug).filter((s): s is string => Boolean(s)))].slice(0, TOPIC_MAX_LINKS);
  const normalizedEntities = [...new Set((input.entities ?? []).map((e) => e.trim().slice(0, 60)).filter(Boolean))].slice(0, TOPIC_MAX_ENTITIES);
  if (existing === null || !existing.trim()) {
    const aliases = [...new Set(input.aliases)].slice(0, 12);
    const meta = [
      `title: ${input.title}`,
      ...(aliases.length ? [`aliases: ${aliasList(aliases)}`] : []),
      ...(normalizedLinks.length ? [`links: ${aliasList(normalizedLinks)}`] : []),
      ...(normalizedEntities.length ? [`entities: ${aliasList(normalizedEntities)}`] : []),
      ...(input.updated ? [`updated: ${input.updated}`] : []),
    ];
    return `---\n${meta.join("\n")}\n---\n\n${lines}\n`;
  }
  const lead = LEAD.exec(existing)?.[0] ?? "";
  const rest = existing.slice(lead.length);
  const block = HEADER_BLOCK.exec(rest);
  let text: string;
  if (!block) {
    const aliases = [...new Set(input.aliases)].slice(0, 12);
    const meta = [
      `title: ${parseTopicHeader(existing).title ?? input.title}`,
      ...(aliases.length ? [`aliases: ${aliasList(aliases)}`] : []),
      ...(normalizedLinks.length ? [`links: ${aliasList(normalizedLinks)}`] : []),
      ...(normalizedEntities.length ? [`entities: ${aliasList(normalizedEntities)}`] : []),
      ...(input.updated ? [`updated: ${input.updated}`] : []),
    ];
    text = `---\n${meta.join("\n")}\n---\n\n${existing}`;
  } else {
    const parsed = parseTopicHeader(existing);
    const knownAliases = parsed.aliases;
    const lowerAliases = new Set(knownAliases.map((alias) => alias.toLowerCase()));
    const addedAliases = input.aliases.filter((alias) => !lowerAliases.has(alias.toLowerCase()));
    const knownLinks = parsed.links ?? [];
    const addedLinks = normalizedLinks.filter((slug) => !knownLinks.includes(slug));
    const knownEntities = parsed.entities ?? [];
    const lowerEntities = new Set(knownEntities.map((e) => e.toLowerCase()));
    const addedEntities = normalizedEntities.filter((e) => !lowerEntities.has(e.toLowerCase()));
    const needsUpdate = addedAliases.length || addedLinks.length || addedEntities.length || (input.updated && parsed.updated !== input.updated);
    if (!needsUpdate) {
      text = existing;
    } else {
      const body = block[1].split(/\r?\n/);
      const upsertList = (field: string, values: string[]) => {
        const at = body.findIndex((line) => new RegExp(`^${field}\\s*:`).test(line));
        if (at === -1) body.push(`${field}: ${aliasList(values)}`);
        else {
          let end = at + 1;
          while (end < body.length && /^\s*-\s+/.test(body[end]!)) end += 1;
          body.splice(at, end - at, `${field}: ${aliasList(values)}`);
        }
      };
      if (addedAliases.length) upsertList("aliases", [...knownAliases, ...addedAliases].slice(0, 12));
      if (addedLinks.length) upsertList("links", [...knownLinks, ...addedLinks].slice(0, TOPIC_MAX_LINKS));
      if (addedEntities.length) upsertList("entities", [...knownEntities, ...addedEntities].slice(0, TOPIC_MAX_ENTITIES));
      if (input.updated && parsed.updated !== input.updated) {
        const at = body.findIndex((line) => /^updated\s*:/.test(line));
        if (at === -1) body.push(`updated: ${input.updated}`);
        else body[at] = `updated: ${input.updated}`;
      }
      text = `${lead}---\n${body.join("\n")}\n---\n${rest.slice(block[0].length)}`;
    }
  }
  return lines ? `${text}${text.endsWith("\n") ? "" : "\n"}${lines}\n` : text;
}
