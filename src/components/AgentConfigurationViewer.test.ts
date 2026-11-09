// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { LocalAgentConfigurationResponse, LocalAgentSkillDocumentResponse, LocalAgentTeamsResponse } from "../../shared/local-dashboard";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const { AgentTeamView } = await import("./AgentTeamPanel");
const member = { kind: "codex", role: "Designer", model: "sample-model", reasoningEffort: "high",
  contextUsed: 1_000, contextWindow: 2_000, state: "working" as const, taskHint: "Synthetic work" };
const snapshot: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1_000, teamCount: 2, teams: [
  { id: "w6", name: "mymausbot", agentCount: 2, activeAgentCount: 1, agents: [
    { ...member, id: "w6:p2", name: "Designer", occupantId: "o1111111111111111" },
    { ...member, id: "w6:p3", name: "Frontend", occupantId: "o3333333333333333", state: "idle" },
  ] },
  { id: "w8", name: "Mini Apps", agentCount: 1, activeAgentCount: 0, agents: [
    { ...member, id: "w8:p1", name: "Lead", occupantId: "o4444444444444444", state: "idle" },
  ] },
] };
const configuration: LocalAgentConfigurationResponse = {
  agentId: "w6:p2", teamId: "w6", occupantId: "o1111111111111111",
  agent: { status: "ready", markdown: "# Verified Agent\n<script>bad()</script>\n[local](file:///private/secret) [web](https://example.test/)" },
  skillReferences: "verified", skillDiscovery: "ready", skills: [
    { id: "s1111111111111111", name: "impeccable", association: "agent", loadedState: "unknown" },
    { id: "s2222222222222222", name: "herdr", association: "team", loadedState: "unknown" },
  ],
};
const missingRules = (teamId: string) => ({ teamId, status: "missing" as const, markdown: null });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
let host: HTMLDivElement;
let root: Root;
const render = async (value: LocalAgentTeamsResponse = snapshot) => {
  await act(async () => root.render(createElement(AgentTeamView, { snapshot: value })));
};
const viewer = () => document.querySelector<HTMLElement>('[data-testid="agent-config-viewer"]');
const trigger = (id: string) => host.querySelector<HTMLButtonElement>(`[data-agent-id="${id}"] button[aria-haspopup="dialog"]`)!;
const teamRulesButton = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="selected-agent-team"] button')]
  .find((button) => button.textContent === "Team rules");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setLocale("en");
  calls.api.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("shows the verified Agent and multiple declared skills without claiming they were loaded or activating file links", async () => {
  calls.api.mockImplementation(async (path: string) => {
    if (path === "/api/local-dashboard/teams/w6/rules") return missingRules("w6");
    if (path === "/api/local-dashboard/agents/w6%3Ap2/configuration") return configuration;
    if (path.endsWith("/skills/s1111111111111111")) return { agentId: "w6:p2", teamId: "w6", occupantId: configuration.occupantId,
      skillId: "s1111111111111111", status: "ready", markdown: "# Actual SKILL.md\n[open file](file:///etc/passwd)" };
    if (path.endsWith("/skills/s2222222222222222")) return { agentId: "w6:p2", teamId: "w6", occupantId: "o2222222222222222",
      skillId: "s2222222222222222", status: "ready", markdown: "# Previous occupant skill" };
    return missingRules("w8");
  });
  await render();
  const button = trigger("w6:p2");
  button.focus();
  await act(async () => button.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Verified Agent"));
  expect(viewer()?.querySelector("script, img, a[href]")).toBeNull();
  expect(viewer()?.textContent).not.toContain("bad()");
  expect(viewer()?.textContent).toContain("file:///private/secret");
  expect(viewer()?.textContent).toContain("https://example.test/");
  const tabs = [...viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Agent", "Skills"]);
  await act(async () => tabs[1]!.click());
  expect(viewer()?.textContent).toContain("impeccable");
  expect(viewer()?.textContent).toContain("herdr");
  expect(viewer()?.textContent).toContain("Declared for this Agent");
  expect(viewer()?.textContent).toContain("Declared for this team");
  expect(viewer()?.textContent?.match(/Loaded in this session: unknown/g)).toHaveLength(2);
  const impeccable = [...viewer()!.querySelectorAll<HTMLButtonElement>("li button")].find((item) => item.textContent?.includes("impeccable"))!;
  await act(async () => impeccable.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Actual SKILL.md"));
  expect(viewer()?.querySelector("a[href]")).toBeNull();
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "All skills")!.click());
  const herdr = [...viewer()!.querySelectorAll<HTMLButtonElement>("li button")].find((item) => item.textContent?.includes("herdr"))!;
  await act(async () => herdr.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("This configuration is unavailable"));
  expect(viewer()?.textContent).not.toContain("Previous occupant skill");
  tabs[1]!.focus();
  await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[0]);
  await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(viewer()).toBeNull();
  expect(document.activeElement).toBe(button);
});

it.each(["missing", "unverified"])("hides the Team rules entry when the exact playbook is %s", async (status) => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules")
    ? { teamId: "w6", status, markdown: null } : configuration);
  await render();
  await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/teams/w6/rules", expect.objectContaining({ signal: expect.any(AbortSignal) })));
  expect(teamRulesButton()).toBeUndefined();
});

it("shows a verified playbook read error and recovers only by retrying that team's rules", async () => {
  let reads = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path === "/api/local-dashboard/teams/w6/rules") return ++reads <= 2
      ? { teamId: "w6", status: "error", markdown: null }
      : { teamId: "w6", status: "ready", markdown: "# Exact mymausbot playbook" };
    return configuration;
  });
  await render();
  await vi.waitFor(() => expect(teamRulesButton()).toBeDefined());
  await act(async () => teamRulesButton()!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("The referenced file could not be read"));
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry read")!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Exact mymausbot playbook"));
  expect(reads).toBe(3);
  expect(viewer()?.querySelector('[role="tablist"]')).toBeNull();
});

it("rechecks the exact playbook on open and hides its entry if the file disappeared", async () => {
  let reads = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path === "/api/local-dashboard/teams/w6/rules") return ++reads === 1
      ? { teamId: "w6", status: "ready", markdown: "# Earlier team rules" } : missingRules("w6");
    return configuration;
  });
  await render();
  await vi.waitFor(() => expect(teamRulesButton()).toBeDefined());
  await act(async () => teamRulesButton()!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("The referenced file is missing"));
  expect(teamRulesButton()).toBeUndefined();
  expect(viewer()?.textContent).not.toContain("Earlier team rules");
  expect(reads).toBe(2);
});

it.each([
  ["missing", "The referenced file is missing.", false],
  ["unverified", "No team role file could be verified for this live member.", false],
  ["error", "The referenced file could not be read.", true],
] as const)("shows an Agent document %s without inventing content", async (status, message, retryable) => {
  let reads = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    if (path.endsWith("/configuration")) return { ...configuration, agent: ++reads === 1
      ? { status, markdown: null } : { status: "ready", markdown: "# Verified after retry" },
      skillReferences: "unverified", skills: [] };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain(message));
  const retry = [...viewer()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry read");
  expect(Boolean(retry)).toBe(retryable);
  if (retry) {
    await act(async () => retry.click());
    await vi.waitFor(() => expect(viewer()?.textContent).toContain("Verified after retry"));
    expect(reads).toBe(2);
  }
});

it.each([
  ["missing", "The referenced file is missing.", false],
  ["error", "The referenced file could not be read.", true],
] as const)("shows a selected SKILL.md %s and retries only a read error", async (status, message, retryable) => {
  let reads = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    if (path.endsWith("/configuration")) return configuration;
    if (path.endsWith("/skills/s1111111111111111")) return { agentId: "w6:p2", teamId: "w6", occupantId: configuration.occupantId,
      skillId: "s1111111111111111", ...(++reads === 1 ? { status, markdown: null } : { status: "ready", markdown: "# Actual skill after retry" }) };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.querySelectorAll('[role="tab"]')).toHaveLength(2));
  await act(async () => viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("impeccable"));
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("li button")].find((button) => button.textContent?.includes("impeccable"))!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain(message));
  const retry = [...viewer()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry read");
  expect(Boolean(retry)).toBe(retryable);
  if (retry) {
    await act(async () => retry.click());
    await vi.waitFor(() => expect(viewer()?.textContent).toContain("Actual skill after retry"));
    expect(reads).toBe(2);
  }
});

it("drops a late member read after that member disappears, then reads the new member without prior content", async () => {
  const first = deferred<LocalAgentConfigurationResponse>();
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    if (path.includes("w6%3Ap2")) return first.promise;
    if (path.includes("w6%3Ap3")) return { ...configuration, agentId: "w6:p3", occupantId: "o3333333333333333",
      agent: { status: "ready", markdown: "# New member only" }, skills: [] };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  expect(viewer()?.textContent).toContain("Reading verified configuration");
  await render({ ...snapshot, teams: snapshot.teams.map((team) => team.id === "w6"
    ? { ...team, agentCount: 1, agents: [team.agents[1]!] } : team) });
  expect(viewer()).toBeNull();
  await act(async () => first.resolve({ ...configuration, agent: { status: "ready", markdown: "# Old member secret" } }));
  expect(document.body.textContent).not.toContain("Old member secret");
  await act(async () => trigger("w6:p3").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("New member only"));
  expect(viewer()?.textContent).not.toContain("Old member secret");
});

it("aborts a prior skill read and never shows it after selecting another skill", async () => {
  const first = deferred<LocalAgentSkillDocumentResponse>();
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    if (path.endsWith("/configuration")) return configuration;
    if (path.endsWith("/skills/s1111111111111111")) return first.promise;
    if (path.endsWith("/skills/s2222222222222222")) return { agentId: "w6:p2", teamId: "w6", occupantId: configuration.occupantId,
      skillId: "s2222222222222222", status: "ready", markdown: "# Current skill" };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.querySelectorAll('[role="tab"]')).toHaveLength(2));
  await act(async () => viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("impeccable"));
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("li button")].find((button) => button.textContent?.includes("impeccable"))!.click());
  const oldSignal = calls.api.mock.calls.find(([path]) => String(path).endsWith("/skills/s1111111111111111"))?.[1]?.signal as AbortSignal;
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "All skills")!.click());
  expect(oldSignal.aborted).toBe(true);
  await act(async () => [...viewer()!.querySelectorAll<HTMLButtonElement>("li button")].find((button) => button.textContent?.includes("herdr"))!.click());
  await act(async () => first.resolve({ agentId: "w6:p2", teamId: "w6", occupantId: configuration.occupantId,
    skillId: "s1111111111111111", status: "ready", markdown: "# Prior skill" }));
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Current skill"));
  expect(viewer()?.textContent).not.toContain("Prior skill");
});

it("shows no document after the local owner loses access", async () => {
  const { ApiError } = await import("@/state/store");
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    throw new ApiError("forbidden", 403);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("This configuration is unavailable"));
  expect(viewer()?.querySelector('[data-testid="agent-config-markdown"]')).toBeNull();
});

it("ignores a prior team's delayed rules after selecting a different office", async () => {
  const first = deferred<{ teamId: string; status: "ready"; markdown: string }>();
  calls.api.mockImplementation(async (path: string) => path === "/api/local-dashboard/teams/w6/rules"
    ? first.promise : missingRules("w8"));
  await render();
  await act(async () => host.querySelectorAll<HTMLButtonElement>("[data-team-house]")[1]!.click());
  await act(async () => first.resolve({ teamId: "w6", status: "ready", markdown: "# Previous team rules" }));
  expect(teamRulesButton()).toBeUndefined();
  expect(document.body.textContent).not.toContain("Previous team rules");
});

it("shows Codex availability separately from team declarations and never calls unverified empty associations none", async () => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules") ? missingRules("w6") : {
    ...configuration, agent: { status: "unverified", markdown: null }, skillReferences: "unverified", skillDiscovery: "ready",
    skills: [{ id: "s3333333333333333", name: "agent-desktop", association: "codex", codexAvailable: true, loadedState: "unknown" }],
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("No team role file could be verified"));
  await act(async () => viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  expect(viewer()?.textContent).toContain("Team or role skill declarations could not be verified");
  expect(viewer()?.textContent).toContain("agent-desktop");
  expect(viewer()?.textContent).toContain("Enabled and discoverable in Codex for this workspace");
  expect(viewer()?.textContent).toContain("Loaded in this session: unknown");
  expect(viewer()?.textContent).not.toContain("No declared or enabled Codex skills were found");
});

it("reports failed Codex discovery without presenting an unverified empty set as no skills", async () => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules") ? missingRules("w6") : {
    ...configuration, skillReferences: "unverified", skillDiscovery: "error", skills: [],
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.querySelectorAll('[role="tab"]')).toHaveLength(2));
  await act(async () => viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  expect(viewer()?.textContent).toContain("Codex skill discovery could not be read for this workspace");
  expect(viewer()?.textContent).not.toContain("No declared or enabled Codex skills were found");
});

it("keeps declared skills visible when Codex discovery times out inside the configuration read budget", async () => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules") ? missingRules("w6") : {
    ...configuration, skillDiscovery: "timeout",
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Verified Agent"));
  expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/agents/w6%3Ap2/configuration",
    expect.objectContaining({ timeoutMs: 12_000, signal: expect.any(AbortSignal) }));
  await act(async () => viewer()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  expect(viewer()?.textContent).toContain("Codex skill discovery timed out for this workspace");
  expect(viewer()?.textContent).toContain("impeccable");
  expect(viewer()?.textContent).toContain("herdr");
});

it("closes a pending same-pane same-name viewer when the opaque occupant changes", async () => {
  const first = deferred<LocalAgentConfigurationResponse>();
  let requests = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/rules")) return missingRules("w6");
    if (path.endsWith("/configuration")) return ++requests === 1 ? first.promise : {
      ...configuration, occupantId: "o2222222222222222", agent: { status: "ready", markdown: "# Replacement occupant" },
    };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  expect(viewer()?.textContent).toContain("Reading verified configuration");
  const next = { ...snapshot, teams: snapshot.teams.map((team) => team.id === "w6"
    ? { ...team, agents: team.agents.map((agent) => agent.id === "w6:p2"
      ? { ...agent, occupantId: "o2222222222222222" } : agent) } : team) };
  await render(next);
  expect(viewer()).toBeNull();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Replacement occupant"));
  await act(async () => first.resolve({ ...configuration, agent: { status: "ready", markdown: "# Previous occupant" } }));
  expect(viewer()?.textContent).not.toContain("Previous occupant");
});

it("rejects an initial response for a different occupant, including a changed-name session", async () => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules") ? missingRules("w6") : {
    ...configuration, occupantId: "o9999999999999999", agent: { status: "ready", markdown: "# Other member" },
  });
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("This configuration is unavailable"));
  expect(viewer()?.textContent).not.toContain("Other member");
});

it("traps initial root Tab and Shift+Tab at actual tabbable boundaries", async () => {
  calls.api.mockImplementation(async (path: string) => path.endsWith("/rules") ? missingRules("w6") : configuration);
  await render();
  await act(async () => trigger("w6:p2").click());
  await vi.waitFor(() => expect(viewer()?.textContent).toContain("Verified Agent"));
  const dialog = viewer()!;
  const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  const [agentTab, skillsTab] = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panel = dialog.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const tab = async (shiftKey = false) => act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
  });
  expect(skillsTab!.tabIndex).toBe(-1);
  expect(panel.tabIndex).toBe(0);
  dialog.focus();
  await tab(true);
  expect(document.activeElement).toBe(panel);
  await tab();
  expect(document.activeElement).toBe(close);
  await tab(true);
  expect(document.activeElement).toBe(panel);
  dialog.focus();
  await tab();
  expect(document.activeElement).toBe(close);
  await act(async () => agentTab!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(agentTab!.tabIndex).toBe(-1);
  expect(skillsTab!.tabIndex).toBe(0);
  const lastSkill = [...dialog.querySelectorAll<HTMLButtonElement>("li button")].at(-1)!;
  lastSkill.focus();
  await tab();
  expect(document.activeElement).toBe(close);
  await tab(true);
  expect(document.activeElement).toBe(lastSkill);
});
