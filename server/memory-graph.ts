import type { DatabaseSync } from "node:sqlite";

import { extractInlineWikilinks, mergeTopicText, normalizeTopicSlug, parseTopicHeader, TOPIC_MAX_LINKS } from "./memory-topics.ts";

export interface MemoryEdge {
  src: string;
  dst: string;
  kind: "link" | "inline_wikilink" | "entity" | "alias";
  weight: number;
}

export function ensureMemoryGraph(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      bot_id TEXT NOT NULL,
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (bot_id, src, dst, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_src ON memory_edges(bot_id, src);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_dst ON memory_edges(bot_id, dst);
  `);
}

function entityKey(value: string): string | null {
  const clean = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  return clean.length >= 2 ? clean : null;
}

export function extractTopicEdges(path: string, raw: string): MemoryEdge[] {
  if (!path.startsWith("memory/") || path === "memory/archive.md" || path.startsWith("memory/log/")) return [];
  const slug = normalizeTopicSlug(path);
  if (!slug) return [];
  const src = `topic:${slug}`;
  const header = parseTopicHeader(raw);
  const edges: MemoryEdge[] = [];
  const seen = new Set<string>();
  const add = (dst: string, kind: MemoryEdge["kind"], weight: number) => {
    if (dst === src) return;
    const key = `${src}|${dst}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ src, dst, kind, weight });
  };
  for (const link of header.links ?? []) add(`topic:${link}`, "link", 1.0);
  for (const link of extractInlineWikilinks(raw)) add(`topic:${link}`, "inline_wikilink", 0.9);
  for (const entity of header.entities ?? []) {
    const key = entityKey(entity);
    if (key) add(`entity:${key}`, "entity", 0.85);
  }
  for (const alias of header.aliases) {
    const key = entityKey(alias);
    if (key) add(`entity:${key}`, "alias", 0.8);
  }
  return edges;
}

export function replaceTopicEdges(db: DatabaseSync, botId: string, path: string, raw: string): void {
  const slug = normalizeTopicSlug(path);
  if (!slug) return;
  const src = `topic:${slug}`;
  db.prepare("DELETE FROM memory_edges WHERE bot_id = ? AND src = ?").run(botId, src);
  const edges = extractTopicEdges(path, raw);
  if (!edges.length) return;
  const insert = db.prepare("INSERT OR REPLACE INTO memory_edges (bot_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, ?)");
  for (const edge of edges) insert.run(botId, edge.src, edge.dst, edge.kind, edge.weight);
}

export function deleteTopicEdges(db: DatabaseSync, botId: string, path?: string): void {
  if (path === undefined) {
    db.prepare("DELETE FROM memory_edges WHERE bot_id = ?").run(botId);
    return;
  }
  const slug = normalizeTopicSlug(path);
  if (!slug) return;
  const node = `topic:${slug}`;
  db.prepare("DELETE FROM memory_edges WHERE bot_id = ? AND (src = ? OR dst = ?)").run(botId, node, node);
}

export function listTopicNeighbors(db: DatabaseSync, botId: string, slug: string): Array<{ topic: string; weight: number }> {
  const node = `topic:${slug}`;
  const direct = db
    .prepare("SELECT src, dst, weight FROM memory_edges WHERE bot_id = ? AND (src = ? OR dst = ?)")
    .all(botId, node, node) as Array<{ src: string; dst: string; weight: number }>;
  const scores = new Map<string, number>();
  for (const row of direct) {
    const other = row.src === node ? row.dst : row.src;
    if (other.startsWith("topic:")) {
      const target = other.slice("topic:".length);
      scores.set(target, Math.max(scores.get(target) ?? 0, row.weight));
    }
  }
  return [...scores.entries()]
    .map(([topic, weight]) => ({ topic, weight }))
    .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic));
}

export function patchBacklinks(input: {
  sourceSlug: string;
  targetSlugs: readonly string[];
  topics: ReadonlyArray<{ name: string }>;
  read: (name: string) => string | null;
  write: (name: string, next: string) => void;
}): string[] {
  const source = normalizeTopicSlug(input.sourceSlug);
  if (!source) return [];
  const bySlug = new Map(input.topics.map((topic) => [normalizeTopicSlug(topic.name), topic.name]));
  const updated: string[] = [];
  for (const rawTarget of input.targetSlugs) {
    const target = normalizeTopicSlug(rawTarget);
    if (!target || target === source) continue;
    const fileName = bySlug.get(target);
    if (!fileName) continue;
    const current = input.read(fileName);
    if (current === null) continue;
    const header = parseTopicHeader(current);
    const existingLinks = header.links ?? [];
    if (existingLinks.includes(source) || existingLinks.length >= TOPIC_MAX_LINKS) continue;
    const next = mergeTopicText(current, {
      title: header.title ?? target.replace(/-/g, " "),
      aliases: [],
      links: [source],
      lines: [],
    });
    if (next !== current) {
      input.write(fileName, next);
      updated.push(fileName);
    }
  }
  return updated;
}
