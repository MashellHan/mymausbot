/** Web Push HTTP routes bound strictly to the authenticated device (`phoneKey(auth)`). */
import { z } from "zod";

import {
  WEB_PUSH_SUBSCRIPTION_ROUTE,
  WEB_PUSH_TEST_ROUTE,
  WEB_PUSH_VAPID_KEY_ROUTE,
  type WebPushSubscriptionResponse,
  type WebPushVapidKeyResponse,
} from "../../shared/web-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import {
  WebPushEndpointError,
  webPushSubscriptionInputSchema,
  type WebPushService,
} from "../web-push.ts";
import { phoneKey } from "./phones.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const DEVICE_ONLY = "Only a paired device can manage its own Web Push subscription.";
const JSON_CONTENT_TYPE = /^application\/json\b/i;

const testRequestSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

export interface WebPushRouteDeps {
  webPush: WebPushService;
  live: (auth: RequestAuth) => boolean;
}

function readJsonErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return status === 413 ? 413 : 400;
}

async function readJsonBodySafe(
  readBody: RouteContext["readBody"],
  req: RouteContext["req"],
  res: RouteContext["res"],
  json: RouteContext["json"],
  limit: number,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await readBody(req, limit) };
  } catch (error) {
    const status = readJsonErrorStatus(error);
    json(res, status, {
      error: status === 413 ? "Request body too large" : "Invalid JSON body",
    });
    return { ok: false };
  }
}

export function createWebPushRoutes(deps: WebPushRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (
      path !== WEB_PUSH_VAPID_KEY_ROUTE &&
      path !== WEB_PUSH_SUBSCRIPTION_ROUTE &&
      path !== WEB_PUSH_TEST_ROUTE
    ) {
      return PASS;
    }

    res.setHeader("Cache-Control", "no-store");
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });

    if (path === WEB_PUSH_VAPID_KEY_ROUTE) {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const enabled = deps.webPush.isEnabled();
      const body: WebPushVapidKeyResponse = {
        enabled,
        publicKey: enabled ? deps.webPush.vapidPublicKey() : null,
      };
      return json(res, 200, body);
    }

    const key = phoneKey(auth);
    if (!key) return json(res, 403, { error: DEVICE_ONLY });

    if (path === WEB_PUSH_SUBSCRIPTION_ROUTE) {
      if (method === "GET") {
        const endpointParam = url.searchParams.get("endpoint") ?? undefined;
        const body: WebPushSubscriptionResponse = {
          subscription: deps.webPush.getSubscription(key, endpointParam),
          vapidPublicKey: deps.webPush.vapidPublicKey(),
        };
        return json(res, 200, body);
      }

      if (method === "DELETE") {
        const endpointParam = url.searchParams.get("endpoint") ?? undefined;
        const removed = deps.webPush.removeSubscription(key, endpointParam);
        const body: WebPushSubscriptionResponse & { removed: number } = {
          removed,
          subscription: deps.webPush.getSubscription(key),
          vapidPublicKey: deps.webPush.vapidPublicKey(),
        };
        return json(res, 200, body);
      }

      if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
      if (!JSON_CONTENT_TYPE.test(String(req.headers["content-type"] ?? ""))) {
        return json(res, 415, { error: "JSON required" });
      }
      const rawRead = await readJsonBodySafe(readBody, req, res, json, 16_384);
      if (!rawRead.ok) return;
      if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
      const parsed = webPushSubscriptionInputSchema.safeParse(rawRead.body);
      if (!parsed.success) {
        return json(res, 400, { error: "Invalid Web Push subscription" });
      }
      try {
        const subscription = await deps.webPush.upsertSubscription(key, parsed.data);
        const body: WebPushSubscriptionResponse = {
          subscription,
          vapidPublicKey: deps.webPush.vapidPublicKey(),
        };
        return json(res, 200, body);
      } catch (error) {
        const status =
          error instanceof WebPushEndpointError
            ? error.status
            : (error as { status?: unknown }).status === 409
              ? 409
              : (error as { status?: unknown }).status === 403
                ? 403
                : 500;
        return json(res, status, { error: error instanceof Error ? error.message : "Could not save subscription" });
      }
    }

    // WEB_PUSH_TEST_ROUTE
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    let targetEndpoint: string | undefined;
    if (req.headers["content-type"] !== undefined) {
      if (!JSON_CONTENT_TYPE.test(String(req.headers["content-type"]))) {
        return json(res, 415, { error: "JSON required" });
      }
      const rawRead = await readJsonBodySafe(readBody, req, res, json, 8_192);
      if (!rawRead.ok) return;
      if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
      const parsed = testRequestSchema.safeParse(rawRead.body);
      if (!parsed.success) return json(res, 400, { error: "Invalid test push request" });
      targetEndpoint = parsed.data.endpoint;
    }
    try {
      const result = await deps.webPush.sendTest(key, targetEndpoint);
      return json(res, 200, result);
    } catch (error) {
      const rawStatus = (error as { status?: unknown }).status;
      const status = rawStatus === 404 || rawStatus === 429 ? rawStatus : 500;
      const retryAfterSec = (error as { retryAfterSec?: unknown }).retryAfterSec;
      if (status === 429 && typeof retryAfterSec === "number" && retryAfterSec > 0) {
        res.setHeader("Retry-After", String(retryAfterSec));
      }
      return json(res, status, { error: error instanceof Error ? error.message : "Could not send test push" });
    }
  };
}
