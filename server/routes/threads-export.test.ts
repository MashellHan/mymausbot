import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WIDGET_SAMPLES } from "../../shared/widget-samples.ts";
import { createAgentCard, prepareWidgetPress } from "../chat-widgets.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store): Promise<string> {
  const deps = {
    store,
    userName: () => "Milind",
    viewerFor: () => ({}),
    visibleTo: () => ({ bot: () => true, group: () => true }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/threads/:id/export", () => {
  it("exports a widget as its text fallback, between the lines around it", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "What is open?" });
    const shown = createAgentCard({ store, bot, threadId: bot.threadId, input: { tool: "show_widget", widget: WIDGET_SAMPLES.pullRequests } });
    if (!shown.ok) throw new Error(shown.error);
    const press = prepareWidgetPress(store, bot.threadId, { messageId: shown.messageId, ref: "confirm" }, undefined);
    if (!press.ok) throw new Error(press.error);
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: press.text, replyToId: press.messageId });
    press.settle();
    const base = await serve(store);

    const markdown = await fetch(`${base}/api/threads/${bot.threadId}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdown.headers.get("x-content-type-options")).toBe("nosniff");
    expect(markdown.headers.get("cache-control")).toBe("private, no-store");
    expect((await markdown.text()).split("\n").slice(2)).toEqual([
      "**Milind:**", "", "What is open?", "",
      "**Scout:**", "",
      "**Pull requests** · mausbot-mobile · 3 open",
      "- iOS: mid-turn steer · #750 · 4 files · passed 2h ago · Ready",
      "- Android: thread pin parity · #739 · 2 files · passed 5h ago · Ready",
      "- iOS: file links, send, attach · #719 · 9 files · 1 test failing · Failing",
      "[Merge the two ready] [Fix #719 first]",
      "",
      "**Milind:**", "", "Merge the two ready", "",
    ]);

    const jsonRes = await fetch(`${base}/api/threads/${bot.threadId}/export?format=json`);
    expect(jsonRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(jsonRes.headers.get("cache-control")).toBe("private, no-store");
    const exported = await jsonRes.json() as { messages: Array<Record<string, any>> };
    expect(exported.messages.map((message) => message.kind)).toEqual(["text", "widget", "text"]);
    expect(exported.messages[1]).toMatchObject({ id: shown.messageId, widget: { v: 1, root: { type: "ListView", title: "Pull requests" }, settled: { ref: "confirm", label: "Merge the two ready", tone: "confirm" } } });
    expect(exported.messages[2]).toMatchObject({ replyToId: shown.messageId });
  });

  it("allowlists inline image MIME types and hardens response headers on /api/threads/:tid/messages/:mid/image", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const pngId = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: Buffer.from("png").toString("base64"), mime: "image/png" }).id;
    const svgId = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: Buffer.from("<svg/>").toString("base64"), mime: "image/svg+xml" }).id;
    const base = await serve(store);

    const pngRes = await fetch(`${base}/api/threads/${bot.threadId}/messages/${pngId}/image`);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(pngRes.headers.get("content-disposition")).toBeNull();
    expect(pngRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pngRes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(pngRes.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const svgRes = await fetch(`${base}/api/threads/${bot.threadId}/messages/${svgId}/image`);
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(svgRes.headers.get("content-disposition")).toBe("attachment");
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svgRes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(svgRes.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
