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

export interface SpreadActivationResult {
  topic: string;
  score: number;
  viaTopic: string;
}

/** 2-hop damped Personalized PageRank over memory_edges with inverse-degree hub damping (HippoRAG 2-lite). */
export function spreadActivation(
  db: DatabaseSync,
  botId: string,
  seeds: ReadonlyMap<string, number>,
  options: { alpha?: number; hops?: number; maxCandidates?: number } = {},
): SpreadActivationResult[] {
  if (!seeds.size) return [];
  const alpha = options.alpha ?? 0.35;
  const hops = options.hops ?? 2;
  const maxCandidates = options.maxCandidates ?? 24;
  const rows = db
    .prepare("SELECT src, dst, weight FROM memory_edges WHERE bot_id = ?")
    .all(botId) as Array<{ src: string; dst: string; weight: number }>;
  if (!rows.length) return [];

  const adj = new Map<string, Map<string, number>>();
  const addUndirected = (u: string, v: string, w: number) => {
    let m = adj.get(u);
    if (!m) { m = new Map(); adj.set(u, m); }
    m.set(v, Math.max(m.get(v) ?? 0, w));
  };
  for (const row of rows) {
    addUndirected(row.src, row.dst, row.weight);
    addUndirected(row.dst, row.src, row.weight);
  }

  let seedTotal = 0;
  const p0 = new Map<string, number>();
  for (const [slug, weight] of seeds) {
    if (weight <= 0) continue;
    const node = slug.startsWith("topic:") || slug.startsWith("entity:") ? slug : `topic:${slug}`;
    p0.set(node, (p0.get(node) ?? 0) + weight);
    seedTotal += weight;
  }
  if (seedTotal <= 0) return [];
  for (const [node, val] of p0) p0.set(node, val / seedTotal);

  let p = new Map<string, number>(p0);
  const origin = new Map<string, { topic: string; mass: number }>();
  for (const [node, mass] of p0) {
    if (node.startsWith("topic:")) origin.set(node, { topic: node.slice("topic:".length), mass });
  }

  for (let step = 0; step < hops; step += 1) {
    const next = new Map<string, number>();
    for (const [node, val] of p0) next.set(node, (1 - alpha) * val);
    for (const [u, mass] of p) {
      const neighbors = adj.get(u);
      if (!neighbors || !neighbors.size) continue;
      let degree = 0;
      for (const w of neighbors.values()) degree += w;
      if (degree <= 0) continue;
      const srcOrigin = origin.get(u)?.topic ?? (u.startsWith("topic:") ? u.slice("topic:".length) : undefined);
      for (const [v, w] of neighbors) {
        const flow = alpha * mass * (w / degree);
        next.set(v, (next.get(v) ?? 0) + flow);
        if (srcOrigin) {
          const prev = origin.get(v);
          if (!prev || flow > prev.mass) origin.set(v, { topic: srcOrigin, mass: flow });
        }
      }
    }
    p = next;
  }

  const seedTopics = new Set(
    [...p0.keys()].filter((k) => k.startsWith("topic:")).map((k) => k.slice("topic:".length)),
  );
  const out: SpreadActivationResult[] = [];
  for (const [node, score] of p) {
    if (!node.startsWith("topic:")) continue;
    const topic = node.slice("topic:".length);
    if (seedTopics.has(topic) || score <= 0.01) continue;
    out.push({ topic, score, viaTopic: origin.get(node)?.topic ?? [...seedTopics][0] ?? topic });
  }
  return out
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic))
    .slice(0, maxCandidates);
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
