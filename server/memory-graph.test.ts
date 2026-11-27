import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { extractTopicEdges, listTopicNeighbors, patchBacklinks, spreadActivation } from "./memory-graph.ts";
import { cosineInt8, quantizeInt8, reciprocalRankFusion } from "./memory-vectors.ts";
import { buildRecall } from "./recall.ts";
import { extractInlineWikilinks, mergeTopicText, parseTopicHeader } from "./memory-topics.ts";
import { applicationDatabase, closeMessageDb } from "./message-db.ts";
import { listMemoryTopics, readMemoryTopic, syncMemoryIndex, writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-memory-graph-test";

describe("Zettelkasten topic frontmatter and memory_edges graph", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("parses and merges links, entities, updated frontmatter and inline wikilinks", () => {
    const raw = [
      "---",
      "title: Project Atlas",
      "description: Cloud migration service",
      "aliases: [atlas, 阿特拉斯]",
      "links: [kubernetes-infra, oncall-runbook]",
      "entities: [Staging Cluster B, Redis]",
      "updated: 2026-04-17",
      "---",
      "- Uses [[deployment-guide]] for canary rollouts",
      "",
    ].join("\n");
    expect(parseTopicHeader(raw)).toEqual({
      title: "Project Atlas",
      description: "Cloud migration service",
      aliases: ["atlas", "阿特拉斯"],
      links: ["kubernetes-infra", "oncall-runbook"],
      entities: ["Staging Cluster B", "Redis"],
      updated: "2026-04-17",
    });
    expect(extractInlineWikilinks(raw)).toEqual(["deployment-guide"]);

    const merged = mergeTopicText(raw, {
      title: "Project Atlas",
      aliases: ["atlas", "migration"],
      links: ["oncall-runbook", "observability"],
      entities: ["Prometheus"],
      updated: "2026-04-18",
      lines: ["- Added alert threshold"],
    });
    const header = parseTopicHeader(merged);
    expect(header.aliases).toEqual(["atlas", "阿特拉斯", "migration"]);
    expect(header.links).toEqual(["kubernetes-infra", "oncall-runbook", "observability"]);
    expect(header.entities).toEqual(["Staging Cluster B", "Redis", "Prometheus"]);
    expect(header.updated).toBe("2026-04-18");
    expect(merged).toContain("- Added alert threshold");

    const edges = extractTopicEdges("memory/project-atlas.md", raw);
    expect(edges.map((e) => `${e.src}->${e.dst}:${e.kind}`)).toEqual(
      expect.arrayContaining([
        "topic:project-atlas->topic:kubernetes-infra:link",
        "topic:project-atlas->topic:deployment-guide:inline_wikilink",
        "topic:project-atlas->entity:staging cluster b:entity",
        "topic:project-atlas->entity:阿特拉斯:alias",
      ]),
    );
  });

  it("patches reciprocal backlinks deterministically and indexes edges in SQLite", () => {
    writeMemoryTopic(BOT, "asha.md", "---\ntitle: Asha\naliases: [阿莎]\nlinks: [diet-hosting]\n---\n- Pescatarian\n");
    writeMemoryTopic(BOT, "diet-hosting.md", "---\ntitle: Dinner Hosting\naliases: [dinner]\n---\n- Keep cilantro separate\n");

    const updated = patchBacklinks({
      sourceSlug: "asha",
      targetSlugs: ["diet-hosting", "nonexistent"],
      topics: listMemoryTopics(BOT),
      read: (name) => readMemoryTopic(BOT, name),
      write: (name, next) => writeMemoryTopic(BOT, name, next),
    });
    expect(updated).toEqual(["diet-hosting.md"]);
    expect(parseTopicHeader(readMemoryTopic(BOT, "diet-hosting.md") ?? "").links).toEqual(["asha"]);

    syncMemoryIndex(BOT);
    const neighbors = listTopicNeighbors(applicationDatabase(), BOT, "asha");
    expect(neighbors).toEqual([{ topic: "diet-hosting", weight: 1 }]);
  });

  it("recalls 2-hop linked topics via damped PPR and bilingual aliases, with Int8 cosine + RRF helpers", () => {
    writeMemoryTopic(BOT, "asha.md", "---\ntitle: Asha\naliases: [阿莎, sister]\nlinks: [diet-hosting]\n---\n- 2026-04-10 · Visiting this weekend\n");
    writeMemoryTopic(BOT, "diet-hosting.md", "---\ntitle: Dinner Hosting\naliases: [hosting]\n---\n- 2026-04-10 · Strictly pescatarian and hates cilantro\n");
    syncMemoryIndex(BOT);

    const spread = spreadActivation(applicationDatabase(), BOT, new Map([["asha", 1]]));
    expect(spread[0]?.topic).toBe("diet-hosting");
    expect(spread[0]?.viaTopic).toBe("asha");

    // Bilingual Chinese query about 阿莎 bridges to asha.md and 2-hop spreads into diet-hosting.md!
    const recalled = buildRecall({
      botId: BOT,
      message: "阿莎周末来家里吃饭要注意什么",
      threadIds: [],
      label: () => "",
      author: () => "",
    });
    expect(recalled?.text).toContain("memory/asha.md");
    expect(recalled?.text).toContain("memory/diet-hosting.md (linked via memory/asha.md)");
    expect(recalled?.text).toContain("cilantro");

    const q1 = quantizeInt8(new Float32Array([1, 0.5, -0.25]));
    const q2 = quantizeInt8(new Float32Array([1, 0.5, -0.25]));
    const q3 = quantizeInt8(new Float32Array([-1, -0.5, 0.25]));
    expect(cosineInt8(q1, q2)).toBeGreaterThan(0.99);
    expect(cosineInt8(q1, q3)).toBeLessThan(-0.99);
    const fused = reciprocalRankFusion([["a", "b"], ["b", "c"]]);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("a")!);
  });
});
