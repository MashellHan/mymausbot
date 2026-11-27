import { describe, expect, it } from "vitest";
import { parseMemoryEntries, isExpired, isActiveEntry } from "./memory-entries.ts";
import { parseTopicHeader } from "./memory-topics.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { selectPlaybookRulesForTurn, type PlaybookRule } from "./memory-playbook.ts";

describe("memory offline evaluation suite (PR-M8)", () => {
  it("enforces bi-temporal validity: excludes superseded, expired, and future validFrom entries", () => {
    const doc = [
      "- 2026-01-10 · from chat · ~~Lives in Seattle~~ · superseded 2026-11-01 by a1b2c3d4e5",
      "- 2026-11-01 · from chat · Lives in Tokyo · from 2026-11-01",
      "- 2026-11-01 · from chat · Attending KubeCon NA · until 2026-11-15",
      "- 2026-11-20 · from chat · Starts new role at Atlas Labs · from 2026-12-15",
    ].join("\n");

    const all = parseMemoryEntries(doc);
    expect(all).toHaveLength(4);
    const active = all.filter((e) => !isExpired(e, "2026-11-27") && isActiveEntry(e, "2026-11-27"));
    expect(active.map((e) => e.body)).toEqual(["Lives in Tokyo"]);

    const futureActive = all.filter((e) => !isExpired(e, "2026-12-20") && isActiveEntry(e, "2026-12-20"));
    expect(futureActive.map((e) => e.body)).toEqual(["Lives in Tokyo", "Starts new role at Atlas Labs"]);
  });

  it("extracts bilingual Zettelkasten links, aliases, and inline wikilinks cleanly", () => {
    const md = [
      "---",
      "title: Asha",
      "aliases: [阿莎, Asha Lin]",
      "links: [diet-hosting, project-atlas]",
      "entities: [Asha, Atlas]",
      "updated: 2026-11-27",
      "---",
      "- 2026-11-20 · Coordinates dinner plans with [[tokyo-restaurants]]",
    ].join("\n");
    const header = parseTopicHeader(md);
    expect(header.aliases).toEqual(["阿莎", "Asha Lin"]);
    expect(header.links).toEqual(["diet-hosting", "project-atlas"]);
    expect(header.entities).toEqual(["Asha", "Atlas"]);
  });

  it("keeps buildSystemPrompt().stable byte-identical across volatile playbook rule injections", () => {
    const rules: PlaybookRule[] = [
      {
        id: "pb-1001",
        scopes: ["git", "pr"],
        when: "opening pull requests",
        instruction: "Keep commits small and let CI run typecheck instead of local tsc.",
        evidence: "always let CI typecheck",
        helpful: 4,
        harmful: 0,
        createdAt: "2026-11-25",
        source: "playbook-learn",
      },
    ];
    const selected = selectPlaybookRulesForTurn({
      rules,
      message: "Please open a git PR for this change",
      enabledTools: ["bash"],
      today: "2026-11-27",
    });
    expect(selected.rules).toHaveLength(1);
    expect(Buffer.byteLength(selected.promptText, "utf8")).toBeLessThanOrEqual(1600);

    const withoutPlaybook = buildSystemPrompt("You are Scout.", "Be helpful and concise.", []);
    const withPlaybook = buildSystemPrompt("You are Scout.", "Be helpful and concise.", [
      { id: "playbooks", label: "Playbooks", text: selected.promptText },
    ]);
    expect(withPlaybook.stable).toBe(withoutPlaybook.stable);
    expect(withPlaybook.volatile).toContain("pb-1001");
  });
});
