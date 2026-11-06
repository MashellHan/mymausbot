import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";

import { createMiniAppsInternalRoutes } from "./mini-apps.ts";

it("rejects local Mini App writes before reading a write-disallowed turn", async () => {
  const deps = {
    localEnabled: () => true,
    bots: () => [{ id: "producer", name: "Producer" }],
  } as unknown as Parameters<typeof createMiniAppsInternalRoutes>[0];
  const route = createMiniAppsInternalRoutes(deps);
  const response = {} as ServerResponse;
  const json = vi.fn();
  const readBody = vi.fn(async () => ({}));
  const requireActive = vi.fn();
  const writeAllowed = vi.fn(() => false);

  for (const path of ["/api/internal/mini-apps/publish", "/api/internal/mini-apps/report"]) {
    json.mockClear();
    await route({ method: "POST", path, res: response, json, botId: "producer", threadId: "turn",
      readBody, requireActive, writeAllowed });
    expect(json).toHaveBeenCalledWith(response, 403, { error: "This turn may only read Mini Apps." });
  }
  expect(requireActive).toHaveBeenCalledTimes(2);
  expect(writeAllowed).toHaveBeenCalledTimes(2);
  expect(readBody).not.toHaveBeenCalled();
});
