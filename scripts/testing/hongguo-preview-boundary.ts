import type { IncomingMessage } from "node:http";
import type { PreviewRoute } from "./preview-fixture.ts";
import type { MiniAppSummary } from "../../shared/mini-apps.ts";
import type { HongguoCatalogResponse, HongguoHistoryEntry,
  HongguoHistoryRequest, HongguoHistoryResponse, HongguoSeriesResponse } from "../../shared/hongguo-mini-app.ts";

const card = { id: "synthetic-hongguo-series", title: "Synthetic Hongguo card", coverUrl: null,
  summary: "Isolated preview data", episodeCount: 1 };
const categories = [{ id: "synthetic", title: "Synthetic category" }];

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error("Synthetic Hongguo request is too large");
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as Record<string, unknown>;
}

/** Every Hongguo preview request is answered here before Vite's production API proxy. */
export function syntheticHongguoPreviewBoundary(fixtureUrl: string) {
  const calls: { method: string; operation: string; mode?: string; status: number }[] = [];
  let entries: HongguoHistoryEntry[] = [];
  let autoplayNext = true;
  const route: PreviewRoute = {
    path: /^\/api\/mini-apps\/([^/]+)\/hongguo(?:\/(.*))?$/,
    handler: async (req, res, match) => {
      const method = req.method ?? "";
      const operation = match?.[2] ?? "";
      let mode: string | undefined;
      const reply = (status: number, value: unknown) => {
        calls.push({ method, operation, ...(mode ? { mode } : {}), status });
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      try {
        const appId = decodeURIComponent(match![1]!);
        const response = await fetch(`${fixtureUrl}/api/mini-apps`, {
          headers: { origin: fixtureUrl }, signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return reply(503, { error: "Synthetic inventory unavailable" });
        const { apps } = await response.json() as { apps: MiniAppSummary[] };
        const app = apps.find((entry) => entry.id === appId && entry.nativeIdentity === "hongguo"
          && entry.nativeKind === "hongguo" && entry.status === "active");
        if (!app) return reply(403, { error: "Synthetic Hongguo app is unavailable" });
        const body = method === "POST" ? await bodyOf(req) : {};
        const revision = method === "POST" ? body.expectedRevision
          : new URL(req.url ?? "", "http://fixture.invalid").searchParams.get("expectedRevision");
        if (String(revision) !== String(app.revision)) return reply(409, { error: "Synthetic revision changed" });
        const scoped = { appId, revision: app.revision };
        if (method === "POST" && operation === "catalog") {
          mode = String(body.mode ?? "");
          if (!["popular", "new", "search", "categories", "category"].includes(mode))
            return reply(400, { error: "Unsupported synthetic catalog mode" });
          const value: HongguoCatalogResponse = { ...scoped,
            items: mode === "categories" ? [] : [card], categories, nextCursor: null };
          return reply(200, value);
        }
        if (method === "POST" && operation === "history") {
          const action = body.action as HongguoHistoryRequest["action"];
          if (action === "save") {
            const entry = body.entry as Omit<HongguoHistoryEntry, "updatedAt"> | undefined;
            if (!entry || typeof entry.seriesId !== "string") return reply(400, { error: "Invalid synthetic history" });
            entries = [{ ...entry, updatedAt: Date.now() }, ...entries.filter((item) => item.seriesId !== entry.seriesId)];
          } else if (action === "delete") entries = entries.filter((entry) => entry.seriesId !== body.seriesId);
          else if (action === "clear") entries = [];
          else if (action !== "list") return reply(400, { error: "Unsupported synthetic history action" });
          const value: HongguoHistoryResponse = { ...scoped, entries, autoplayNext };
          return reply(200, value);
        }
        if (method === "POST" && operation === "series" && body.seriesId === card.id) {
          const value: HongguoSeriesResponse = { ...scoped, series: { ...card, episodes: [
            { id: "synthetic-episode", number: 1, title: "Synthetic episode", availability: "available", imageUrl: null },
          ] } };
          return reply(200, value);
        }
        if (method === "POST" && operation === "playback" && body.seriesId === card.id
          && body.episodeId === "synthetic-episode")
          return reply(200, { ...scoped, status: "unavailable", reason: "provider-unavailable" });
        if (method === "POST" && operation === "preferences" && typeof body.autoplayNext === "boolean") {
          autoplayNext = body.autoplayNext;
          return reply(200, { ...scoped, autoplayNext });
        }
        return reply(404, { error: "No synthetic Hongguo response for this path" });
      } catch {
        return reply(400, { error: "Invalid synthetic Hongguo request" });
      }
    },
  };
  return { route, calls };
}
