import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";

import { createMiniAppsInternalRoutes } from "./mini-apps.ts";

it("rejects local Mini App publication before reading a write-disallowed turn", async () => {
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

  await route({ method: "POST", path: "/api/internal/mini-apps/publish", res: response, json, botId: "producer",
    readBody, requireActive, writeAllowed });
  expect(json).toHaveBeenCalledWith(response, 403, { error: "This turn may only read Mini Apps." });
  expect(requireActive).toHaveBeenCalledOnce();
  expect(writeAllowed).toHaveBeenCalledOnce();
  expect(readBody).not.toHaveBeenCalled();
});
