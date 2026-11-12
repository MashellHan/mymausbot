import { beforeEach, afterEach, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ save: vi.fn(), confirm: vi.fn(async () => {}) }));
vi.mock("./config.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("./config.ts")>(),
  saveConfig: persistence.save, confirmSessionConfig: persistence.confirm }));
import { ensureProjectSession, keepSessionWith } from "./composio-session.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OMB_COMPOSIO_API", "https://fixture.invalid/api");
  persistence.confirm.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(new URL(url).pathname).toMatch(/\/tool_router\/session(?:\/trs_fixture)?$/);
    if (init?.method === "POST") expect(JSON.parse(String(init.body)).user_id).toBe("fixture_person");
    return new Response(JSON.stringify({ session_id: "trs_fixture", mcp: { type: "http", url: "https://fixture.invalid/mcp" },
      config: { user_id: "fixture_person", multi_account: { enable: true }, auth_configs: {} } }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps a member's new Session outside the workspace credential handoff", async () => {
  const composio = { apiKey: "ak_fixture", userId: "fixture_person" };
  const keep = vi.fn();
  keepSessionWith(composio, keep);
  await expect(ensureProjectSession({ composio }, {})).resolves.toMatchObject({ session_id: "trs_fixture" });
  expect(keep).toHaveBeenCalledExactlyOnceWith({ userId: "fixture_person", sessionId: "trs_fixture" });
  expect(composio).toMatchObject({ sessionId: "trs_fixture" });
  expect(persistence.save).not.toHaveBeenCalled();
  expect(persistence.confirm).not.toHaveBeenCalled();
});

it("waits for the workspace credential handoff before admitting new Session IDs", async () => {
  const composio = { apiKey: "ak_fixture", userId: "fixture_person" };
  persistence.confirm.mockImplementationOnce(async () => {
    expect(persistence.save).toHaveBeenCalledExactlyOnceWith({ composio: { userId: "fixture_person", sessionId: "trs_fixture" } });
    expect(composio).not.toHaveProperty("sessionId");
    throw new Error("fixture handoff refused");
  });
  await expect(ensureProjectSession({ composio }, {})).rejects.toThrow("fixture handoff refused");
  expect(composio).not.toHaveProperty("sessionId");
});
