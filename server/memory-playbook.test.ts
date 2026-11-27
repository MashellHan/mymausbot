import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  makePlaybookRuleId,
  parsePlaybook,
  PLAYBOOK_INJECT_MAX_BYTES,
  playbookUtility,
  readPlaybook,
  selectPlaybookRulesForTurn,
  serializePlaybook,
  shouldRetireRule,
  writePlaybook,
  type PlaybookRule,
} from "./memory-playbook.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-memory-playbook-test";

describe("ACE procedural playbook store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("round-trips atomic WHEN/DO rules through Markdown cleanly", () => {
    const rule: PlaybookRule = {
      id: makePlaybookRuleId("running checks in OpenMausBot", "use pnpm check:edit and targeted tests"),
      scopes: ["bash", "pnpm"],
      when: "running checks in OpenMausBot",
      instruction: "use pnpm check:edit and targeted tests",
      evidence: "Don't run pnpm build locally",
      helpful: 6,
      harmful: 0,
      createdAt: "2026-04-12",
      lastUsedAt: "2026-04-16",
      source: "Engineering Chat",
    };
    writePlaybook(BOT, [rule]);
    const loaded = readPlaybook(BOT);
    expect(loaded).toEqual([rule]);
    expect(parsePlaybook(serializePlaybook([rule]))).toEqual([rule]);
  });

  it("ranks rules by relevance x utility, retires harmful rules, and enforces 1,600-byte ceiling", () => {
    const rules: PlaybookRule[] = [
      {
        id: "pb-good01",
        scopes: ["pnpm", "test"],
        when: "running repository checks",
        instruction: "run targeted vitest files only",
        evidence: "only run 1-3 affected test files",
        helpful: 5,
        harmful: 0,
        createdAt: "2026-04-10",
        source: "Chat",
      },
      {
        id: "pb-bad002",
        scopes: ["pnpm", "test"],
        when: "running repository checks",
        instruction: "always run full build",
        evidence: "old rule",
        helpful: 0,
        harmful: 2,
        createdAt: "2026-04-10",
        source: "Chat",
      },
      {
        id: "pb-zh0003",
        scopes: ["周报", "汇报"],
        when: "用中文总结周报数据时",
        instruction: "先列出三个环比变化点，再给简短说明",
        evidence: "以后周报先给三个环比变化点",
        helpful: 4,
        harmful: 0,
        createdAt: "2026-04-14",
        source: "Daily Brief",
      },
    ];
    expect(shouldRetireRule(rules[1]!, "2026-04-17")).toBe(true);
    expect(playbookUtility(rules[0]!, "2026-04-17")).toBeGreaterThan(playbookUtility(rules[1]!, "2026-04-17"));

    const enSelection = selectPlaybookRulesForTurn({ rules, message: "please run pnpm test checks", today: "2026-04-17" });
    expect(enSelection.rules.map((r) => r.id)).toEqual(["pb-good01"]);
    expect(Buffer.byteLength(enSelection.promptText, "utf8")).toBeLessThanOrEqual(PLAYBOOK_INJECT_MAX_BYTES);

    const zhSelection = selectPlaybookRulesForTurn({ rules, message: "帮我写本周周报数据汇报", today: "2026-04-17" });
    expect(zhSelection.rules.map((r) => r.id)).toEqual(["pb-zh0003"]);
  });

  it("injects into the volatile playbooks section without changing stable system prompt bytes", () => {
    const a = buildSystemPrompt("You are Scout.", "Be helpful.", [{ id: "playbooks", label: "Playbooks", text: "" }]);
    const b = buildSystemPrompt("You are Scout.", "Be helpful.", [{ id: "playbooks", label: "Playbooks", text: "\n- [pb-1] When testing: run targeted tests.\n" }]);
    expect(a.stable).toBe(b.stable);
    expect(b.volatile).toContain("pb-1");
  });
});
