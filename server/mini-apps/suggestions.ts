import { createHash } from "node:crypto";
import { z } from "zod";
import type { MiniAppSuggestion, MiniAppSuggestionsRequest, MiniAppSuggestionsResult, MiniAppSummary } from "../../shared/mini-apps.ts";
import type { SideJobText } from "../side-jobs.ts";
import type { Store } from "../store.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import { appFailure } from "./validation.ts";

const requestSchema = z.object({ botId: z.string().regex(/^[\w-]{1,128}$/), threadId: z.string().min(1).max(128) }).strict();
const modelSchema = z.object({ matches: z.array(z.object({ appId: z.string(), capability: z.string(), taskPhrase: z.string() }).strict()).max(3) }).strict();
type ModelMatch = z.infer<typeof modelSchema>["matches"][number];
const RETRY_DELAY_MS = 60_000;

function capabilities(app: MiniAppSummary): string[] {
  return app.capabilities?.length ? app.capabilities : app.description.trim() ? [app.description.trim().slice(0, 160)] : [];
}

function reportsActivities(title: string): boolean {
  const task = title.trim().slice(0, 160);
  return /统计|汇总|监测|跟踪|\b(?:track|monitor|count|measure|compare|report|summarize)\b/iu.test(task)
    && /拉取请求|合并请求|\b(?:prs?|pull requests?)\b/iu.test(task)
    && /提交|\bcommits?\b/iu.test(task)
    && /(?:词元|令牌)(?:用量|消耗)|\btokens?\s*(?:用量|消耗|usage\b|consumption\b|counts?\b)|\b(?:agent|model|llm) tokens?\b/iu.test(task)
    && !/(?:访问|刷新|登录|会话|鉴权)\s*(?:token|令牌)|\b(?:access|refresh|login|api|session|bearer|auth|oauth|csrf|jwt)[ -]tokens?\b/iu.test(task);
}

export class MiniAppSuggestions {
  private readonly deps: {
    apps: MiniApps;
    store: Pick<Store, "bot" | "taskByThread">;
    writer(botId: string): SideJobText | null;
  };
  private readonly cache = new Map<string, ModelMatch[]>();
  private readonly running = new Set<string>();
  private readonly unavailableUntil = new Map<string, number>();

  constructor(deps: {
    apps: MiniApps;
    store: Pick<Store, "bot" | "taskByThread">;
    writer(botId: string): SideJobText | null;
  }) { this.deps = deps; }

  private retryLater(key: string): void {
    this.unavailableUntil.set(key, Date.now() + RETRY_DELAY_MS);
    if (this.unavailableUntil.size > 64) this.unavailableUntil.delete(this.unavailableUntil.keys().next().value!);
  }

  read(actor: MiniAppActor, raw: unknown): MiniAppSuggestionsResult {
    actor.assertActive();
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw appFailure(400, "Choose the current Bot and task.");
    const { botId, threadId } = parsed.data satisfies MiniAppSuggestionsRequest;
    const bot = this.deps.store.bot(botId);
    const task = this.deps.store.taskByThread(botId, threadId);
    if (!bot || !task || bot.threadId !== threadId || task.archivedAt || bot.hidden || bot.movedTo) {
      throw appFailure(404, "The selected Bot task is unavailable.");
    }
    const apps = this.deps.apps.list(actor).filter((app) => app.status === "active")
      .map((app) => ({ ...app, responsibleBotId: app.responsibleBotId ?? null, capabilities: app.capabilities ?? [] }));
    const developed = this.deps.apps.developedBy(botId);
    const identity = JSON.stringify({ botId, threadId, role: [bot.title, bot.description, bot.soulHash, bot.assignedSkills],
      model: bot.modelSelection, task: [task.title, task.updatedAt],
      apps: apps.map((app) => [app.id, app.revision, app.responsibleBotId, app.publisherBotIds, app.capabilities, app.description,
        app.dashboardIdentity, app.dashboard, developed.has(app.id)]) });
    const key = createHash("sha256").update(identity).digest("hex");
    const usage = reportsActivities(task.title) ? apps.filter((app) => app.dashboardIdentity === "usage"
      && app.dashboard?.kind === "usage" && app.dashboard.resources.includes("usage")) : [];
    const activities = usage.length === 1 ? usage[0] : undefined;
    const candidates = apps.filter((app) => app !== activities && capabilities(app).length)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 80);
    const needsWriter = candidates.length > 0 && task.title.trim().length >= 4;
    const byId = new Map(candidates.map((app) => [app.id, app]));
    const taskTitle = task.title.slice(0, 80);
    if (!this.cache.has(key) && !this.running.has(key) && needsWriter &&
        (this.unavailableUntil.get(key) ?? 0) <= Date.now()) {
      const writer = this.deps.writer(botId);
      if (writer) {
        this.running.add(key);
        const prompt = JSON.stringify({ instruction: "Return JSON {matches:[{appId,capability,taskPhrase}]}, at most 3. " +
          "Choose only apps directly useful for this exact task. Abstain on weak or unclear relevance. " +
          "Copy capability exactly from an app's listed capabilities and taskPhrase exactly from the task title. " +
          "Never infer responsibility, development, permissions, or a capability absent from this input.",
        bot: { title: bot.title.slice(0, 160), description: bot.description.slice(0, 500), skills: bot.assignedSkills?.slice(0, 20) ?? [] },
        task: taskTitle, apps: candidates.map((app) => ({ id: app.id, capabilities: capabilities(app) })) });
        const abort = new AbortController();
        const deadline = new Promise<never>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new Error("Mini App suggestion deadline elapsed")), { once: true });
        });
        const timer = setTimeout(() => abort.abort(), 8_000);
        void Promise.race([
          Promise.resolve().then(() => { actor.assertActive(); return writer.generateText(prompt, { signal: abort.signal, timeoutMs: 8_000 }); }),
          deadline,
        ]).then((raw) => {
          const parsed = modelSchema.parse(JSON.parse(raw));
          const matches = parsed.matches.filter((match) => {
            const app = byId.get(match.appId);
            return app && capabilities(app).includes(match.capability) && taskTitle.includes(match.taskPhrase)
              && match.taskPhrase.trim().length >= 4;
          });
          if (parsed.matches.length && !matches.length) {
            this.retryLater(key);
            return;
          }
          this.cache.set(key, matches);
          this.unavailableUntil.delete(key);
          if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        }).catch(() => { this.retryLater(key); }).finally(() => { clearTimeout(timer); this.running.delete(key); });
      } else this.retryLater(key);
    }

    const suggestions: MiniAppSuggestion[] = activities ? [{ app: activities, reason: { kind: "activities-task" } }] : [];
    for (const match of this.cache.get(key) ?? []) {
      const app = byId.get(match.appId);
      if (!app || !capabilities(app).includes(match.capability) || !task.title.includes(match.taskPhrase) ||
          match.taskPhrase.trim().length < 4) continue;
      suggestions.push({ app, reason: { kind: "task", capability: match.capability, taskPhrase: match.taskPhrase } });
    }
    for (const app of apps) {
      if (app.responsibleBotId === botId) suggestions.push({ app, reason: { kind: "responsible" } });
      else if (developed.has(app.id)) suggestions.push({ app, reason: { kind: "developed" } });
      else if (app.publisherBotIds.includes(botId)) suggestions.push({ app, reason: { kind: "publisher-grant" } });
    }
    const priority = { responsible: 0, developed: 1, task: 2, "activities-task": 2, "publisher-grant": 3 };
    suggestions.sort((a, b) => priority[a.reason.kind] - priority[b.reason.kind] || a.app.createdAt - b.app.createdAt || a.app.id.localeCompare(b.app.id));
    const seen = new Set<string>();
    const bounded: MiniAppSuggestion[] = [];
    for (const suggestion of suggestions) {
      if (seen.has(suggestion.app.id)) continue;
      seen.add(suggestion.app.id);
      bounded.push(suggestion);
      if (bounded.length === 3) break;
    }
    actor.assertActive();
    const refreshPending = this.running.has(key);
    const status = refreshPending ? "pending" : !needsWriter || this.cache.has(key) ? "ready" : "unavailable";
    return { botId, threadId, suggestions: bounded, refreshPending, status, ...(status === "unavailable" ? {
      retryAfterMs: Math.max(0, (this.unavailableUntil.get(key) ?? 0) - Date.now()),
    } : {}) };
  }
}
