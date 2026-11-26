import { describe, expect, it } from "vitest";

import {
  buildDelegatedForwardPrompt,
  buildProgressiveContinuationPrompt,
  buildSoftRedirectPrompt,
  classifyBusyIntake,
  extractTurnProgressSummary,
  isSoftRedirectIntent,
} from "./progressive-intake.ts";
import type { Message } from "./store.ts";

describe("progressive-intake classification", () => {
  it("recognizes explicit English and Chinese soft redirects without misfiring on style tweaks or bare quotes", () => {
    expect(isSoftRedirectIntent("stop using tabs and indent with spaces")).toBe(false);
    expect(isSoftRedirectIntent("Also check the footer contrast while you're there")).toBe(false);
    expect(isSoftRedirectIntent('The README says "cancel that refactor" in an example')).toBe(false);
    expect(isSoftRedirectIntent("不要忘了运行测试")).toBe(false);

    expect(isSoftRedirectIntent("Cancel that refactor and write unit tests instead")).toBe(true);
    expect(isSoftRedirectIntent("Stop what you're doing, switch to the billing API")).toBe(true);
    expect(isSoftRedirectIntent("Never mind, start over with SQLite")).toBe(true);
    expect(isSoftRedirectIntent("取消当前重构，直接改写登录模块")).toBe(true);
    expect(isSoftRedirectIntent("算了，直接检查权限边界")).toBe(true);
    expect(isSoftRedirectIntent("换个方向，做并发读写分离")).toBe(true);
  });

  it("routes busy inputs across live-steer, progressive-continue, and soft-redirect cleanly", () => {
    expect(
      classifyBusyIntake({
        text: "stop using tabs and indent with spaces",
        engineCanSteer: true,
      }),
    ).toMatchObject({ mode: "live-steer", initialState: "processing", shouldInterrupt: false, redirect: false });

    expect(
      classifyBusyIntake({
        text: "Also check edge cases",
        engineCanSteer: false,
      }),
    ).toMatchObject({ mode: "progressive-continue", initialState: "received", shouldInterrupt: false });

    expect(
      classifyBusyIntake({
        text: "Look at this screenshot",
        carriesImages: true,
        engineCanSteer: true,
        engineCanSteerImages: false,
      }),
    ).toMatchObject({ mode: "progressive-continue", initialState: "received", blockedBy: "images" });

    expect(
      classifyBusyIntake({
        text: "Cancel the previous plan and write tests instead",
        engineCanSteer: false,
      }),
    ).toMatchObject({ mode: "soft-redirect", initialState: "received", shouldInterrupt: true, redirect: true });

    expect(
      classifyBusyIntake({
        text: "Please check tests too",
        engineCanSteer: true,
        followUp: "restart",
      }),
    ).toMatchObject({ mode: "soft-redirect", initialState: "received", shouldInterrupt: true, redirect: true, chose: "restart" });

    expect(
      classifyBusyIntake({
        text: "Cancel that refactor and switch to B",
        engineCanSteer: true,
        followUp: "queue",
      }),
    ).toMatchObject({ mode: "progressive-continue", initialState: "received", shouldInterrupt: false, chose: "queue" });
  });

  it("allows delegation-forward eligibility only when delegated work is active and message carries no images", () => {
    expect(
      classifyBusyIntake({
        text: "Also verify error paths",
        engineCanSteer: false,
        hasActiveDelegation: true,
      }),
    ).toMatchObject({ allowDelegationForward: true });

    expect(
      classifyBusyIntake({
        text: "See screenshot",
        carriesImages: true,
        engineCanSteer: false,
        hasActiveDelegation: true,
      }),
    ).toMatchObject({ allowDelegationForward: false });
  });
});

describe("progressive-intake context summaries & prompts", () => {
  const msg = (partial: Partial<Message> & Pick<Message, "role" | "kind">): Message =>
    ({ id: `m_${Math.random()}`, at: 1_000, ...partial }) as Message;

  it("extracts completed tool steps and partial assistant progress for target turn", () => {
    const summary = extractTurnProgressSummary(
      [
        msg({ role: "user", kind: "text", text: "Old request" }),
        msg({ role: "bot", kind: "text", text: "Old reply", turnId: "t0" }),
        msg({ role: "user", kind: "text", text: "Inspect server routing" }),
        msg({ role: "bot", kind: "activity", turnId: "t1", tool: { name: "read server/index.ts", ok: true, output: "read 200 lines" } }),
        msg({ role: "bot", kind: "text", turnId: "t1", text: "Found direct busy branch." }),
      ],
      "t1",
    );
    expect(summary).toContain("[ok] read server/index.ts");
    expect(summary).toContain("Found direct busy branch.");
    expect(summary).not.toContain("Old reply");
  });

  it("preserves exact blank-line separated follow-ups and soft-redirect context blocks", () => {
    const continuation = buildProgressiveContinuationPrompt({
      followUpPrompts: ["steer two", "steer three"],
      progressSummary: "Completed tool steps:\n- [ok] read config.ts",
    });
    expect(continuation).toContain("steer two\n\nsteer three");
    expect(continuation).toContain("read config.ts");

    const redirectPrompt = buildSoftRedirectPrompt({
      latestPrompt: "Cancel that refactor and write unit tests instead",
      supersededText: "Refactor storage layer",
      progressSummary: "Completed tool steps:\n- [ok] audited store.ts",
    });
    expect(redirectPrompt).toContain("Refactor storage layer");
    expect(redirectPrompt).toContain("audited store.ts");
    expect(redirectPrompt).toContain("Cancel that refactor and write unit tests instead");

    expect(buildDelegatedForwardPrompt({ userText: "Include metrics", assignmentId: "as_9" })).toContain("assignment as_9");
    expect(buildDelegatedForwardPrompt({ userText: "Switch to JSON", redirect: true })).toContain("direction change");
  });
});
