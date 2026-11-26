// The app_settings tool for one turn: find, get and set over the registry, where the entry's tier is the whole policy.
// Writes happen only in the owner's own turn, a confirm setting always waits on a card the owner answers (Full access
// never skips it), a secret never passes through the bot, and an owner-only setting is only explained.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { isSettingsCardId, SETTINGS_CARD_IDS, type AppSettingRequest, type SettingsCardId } from "../../shared/app-settings.ts";
import type { Notification } from "../../shared/notification.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import { json } from "../harness/http.ts";
import { buildNotification } from "../notify.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { turnWaitedOnPerson } from "../waiting-on-person.ts";
import { display, findSettings, personOnly, settingLocation, type SettingEntry, type WritableEntry } from "./registry.ts";
import type { ThemeTool } from "../themes/tool.ts";
import { cardElsewhere, cardNotInRoom, cardShownStatus, SETTINGS_CARDS } from "./cards.ts";
import type { TakenPicture } from "./picture-file.ts";
import { findPlaces, placesList } from "./places.ts";

export const TOOL = "app_settings";
export const APP_SETTINGS_HOLD_MS = 9 * 60_000;
export const WRITE_BUDGET = 10;
const FIND_LIMIT = 8;
const THEME_ACTIONS: readonly string[] = ["theme", "set_theme", "add_theme_asset", "theme_history", "undo_theme"];
const NOT_RETRY = "Do not retry it; ask the user what they would like instead.";
const NOT_SET = "not set";
const text = (value: string) => value || NOT_SET;
interface Shown { before?: string; after: string }
const said = ({ before, after }: Shown) => before === undefined ? after : `${text(before)} → ${text(after)}`;

/** The tool sends every value as text so strict-schema providers accept it; numbers, true/false and JSON lists are read
 * back from it when the text alone does not fit the setting. */
function parseValue(entry: WritableEntry, value: unknown) {
  const direct = entry.value.safeParse(value);
  if (direct.success || typeof value !== "string") return direct;
  try {
    const json: unknown = JSON.parse(value);
    const read = entry.value.safeParse(json);
    return read.success || (typeof json === "object" && json !== null) ? read : direct;
  } catch {
    return direct;
  }
}

export interface Turn {
  botId: string;
  threadId: string;
  generation: string;
}

type Outcome = { kind: "applied"; text: string; after: string } | { kind: "failed"; error: string } | { kind: "denied" } | { kind: "timeout" } | { kind: "stopped" };
interface Held {
  botId: string;
  threadId: string;
  entry: WritableEntry;
  value: unknown;
  shown: Shown;
  settle(outcome: Outcome): void;
  timer: ReturnType<typeof setTimeout>;
  answered?: true;
  applying?: true;
}
interface Undoable {
  entry: WritableEntry;
  before: unknown;
  after: unknown;
  target: unknown;
  person?: string;
}

export type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

export interface AppSettingsDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage" | "setActivity" | "setTaskActivity" | "taskByThread">;
  dataDir: string;
  entries: readonly SettingEntry[];
  holdMs?: number;
  /** Non-null when the turn is the owner's own (phones.turnOwner). */
  turnOwner(turn: Turn): string | null;
  guestDriven(threadId: string): boolean;
  /** The secret card, as request_credential posts it. */
  requestCredential(bot: BotRecord, threadId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  connectorThread(botId: string, threadId: string): { group?: GroupRecord } | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
  notify(notification: Notification | null): void;
  language(threadId: string): string | undefined;
  automated?(turn: Turn): boolean;
  /** The person's own themes; absent where the server offers none. */
  themes?: ThemeTool;
  /** For a setting that takes a picture file: stores the file the bot names, or says why not. */
  pictures?: { take(turn: Turn, path: string): Promise<TakenPicture>; discard(avatarUrl: string): void };
  /** Settings cards: whether a card's control exists on this server's own computer, and whether its setting is known to be on (null when the server cannot tell). Absent: no cards here. */
  cards?: { here(id: SettingsCardId): boolean; on(id: SettingsCardId): true | null };
}

export function createAppSettings(deps: AppSettingsDeps) {
  const { store, entries } = deps;
  const holdMs = deps.holdMs ?? APP_SETTINGS_HOLD_MS;
  const held = new Map<string, Held>();
  const openByBot = new Map<string, string>();
  const undoable = new Map<string, Undoable>();
  const writes = new Map<string, number>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const reply = (status: number, body: Record<string, unknown>) => ({ status, body });
  const refuse = (status: number, error: string) => reply(status, { error });
  const describe = (entry: SettingEntry) => ({ id: entry.id, label: entry.label, tier: entry.tier, value: text(entry.read()), where: settingLocation(entry.where) });
  const decide = (turn: Turn, bot: BotRecord | undefined, entry: SettingEntry, summary: string, decision: "auto-approved" | "card-shown", requestId?: string) =>
    appendDecision(deps.dataDir, { threadId: turn.threadId, ...(requestId ? { requestId } : {}), botId: turn.botId, botName: bot?.name, tool: TOOL, summary: `${entry.id}: ${summary}`, decision, source: "app-settings" });
  const from = (bot: BotRecord, threadId: string) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
  const card = (bot: BotRecord, threadId: string, entry: WritableEntry, { before, after }: Shown, requestId: string, options: string[], settled: Partial<OptionCardData>) => {
    const language = deps.language(threadId);
    const shown = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const appSettingRequest: AppSettingRequest = { settingId: entry.id, label: entry.label, ...(before === undefined ? {} : { before }), after, tier: entry.tier };
    return store.appendMessage(threadId, {
      role: "bot", kind: "options", ...from(bot, threadId),
      card: { title: serverLine(language, "server.appSettings.change", { label: entry.label }), subtitle: before === undefined ? after : `${shown(before)} → ${shown(after)}`, options, requestId, tool: TOOL, fixedOptions: true, appSettingRequest, ...settled },
    });
  };
  const spendWrite = (turn: Turn): string | null => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent >= WRITE_BUDGET) return `This turn has already changed ${WRITE_BUDGET} settings. Ask the user to send a new message before changing more.`;
    writes.set(turn.generation, spent + 1);
    if (writes.size > 200) writes.delete(writes.keys().next().value!);
    return null;
  };

  async function applyConfirmed(entry: WritableEntry, value: unknown, shown: Shown): Promise<Outcome> {
    if (entry.describe) {
      const current = entry.describe(value);
      if ("refusal" in current) return { kind: "failed", error: current.refusal };
      if (current.change !== shown.after) return { kind: "failed", error: "The setting changed while the card was waiting. Ask the user to review it again." };
    }
    const refusal = await entry.write(value);
    if (refusal) return { kind: "failed", error: refusal };
    const after = entry.read();
    return { kind: "applied", text: shown.before === undefined ? `Done: ${shown.after}. ${entry.label} now: ${text(after)}.` : `Changed ${entry.label} from ${text(shown.before)} to ${text(after)}.`, after };
  }

  async function setConfirm(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, shown: Shown, ended?: AbortSignal) {
    if (ended?.aborted) return refuse(409, `This turn was stopped, so nothing changed. ${NOT_RETRY}`);
    if (openByBot.has(bot.id)) return refuse(409, "A settings change is already waiting on the user. End your turn and wait for the answer.");
    const requestId = randomUUID();
    let settle!: (outcome: Outcome) => void;
    const answer = new Promise<Outcome>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => settleHold(requestId, { kind: "timeout" }), holdMs);
    timer.unref?.();
    const onAbort = () => settleHold(requestId, { kind: "stopped" });
    ended?.addEventListener("abort", onAbort, { once: true });
    held.set(requestId, { botId: bot.id, threadId: turn.threadId, entry, value, shown, settle, timer });
    openByBot.set(bot.id, requestId);
    const message = card(bot, turn.threadId, entry, shown, requestId, ["Change", "Cancel"], {});
    decide(turn, bot, entry, said(shown), "card-shown", requestId);
    waiting(bot, turn.threadId, true);
    deps.notify(buildNotification("approval", bot, turn.threadId, message.card!.subtitle, { avatarUrl: bot.avatarUrl }));
    const outcome = await answer;
    ended?.removeEventListener("abort", onAbort);
    held.delete(requestId);
    if (openByBot.get(bot.id) === requestId) openByBot.delete(bot.id);
    waiting(bot, turn.threadId, false);
    if (outcome.kind === "timeout" || outcome.kind === "stopped") {
      const stale = store.messagesFor(turn.threadId).find((candidate) => candidate.id === message.id);
      if (stale?.card && !stale.card.answered) store.patchMessage(turn.threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
      return refuse(409, outcome.kind === "timeout" ? `Nobody answered the "${entry.label}" card in time, so nothing changed. ${NOT_RETRY}`
        : `This turn was stopped, so the "${entry.label}" card was closed and nothing changed. ${NOT_RETRY}`);
    }
    if (outcome.kind === "denied") return refuse(409, `The user cancelled the change to ${entry.label}. ${NOT_RETRY}`);
    if (outcome.kind === "failed") return refuse(409, `The user allowed it, but the change failed: ${outcome.error}`);
    return reply(200, { text: outcome.text });
  }

  function waiting(bot: BotRecord, threadId: string, on: boolean) {
    const group = deps.connectorThread(bot.id, threadId)?.group;
    if (group) {
      if (deps.activeGroupTurnForBot(bot.id)?.threadId === threadId && (on || turnWaitedOnPerson(store.bot(bot.id)))) store.setActivity(bot.id, on ? "waiting-on-you" : "working");
    } else if (on ? store.taskByThread(bot.id, threadId)?.busy : turnWaitedOnPerson(store.taskByThread(bot.id, threadId))) {
      store.setTaskActivity(bot.id, threadId, on ? "waiting-on-you" : "working");
    }
  }

  function settleHold(requestId: string, outcome: Outcome) {
    const entry = held.get(requestId);
    if (!entry || entry.answered || (entry.applying && (outcome.kind === "timeout" || outcome.kind === "stopped"))) return;
    entry.answered = true;
    clearTimeout(entry.timer);
    entry.settle(outcome);
  }

  /** Applies the change, posts its applied card with Undo, and logs it in the decision log. */
  async function apply(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, change?: string, person?: string) {
    const before = structuredClone(await entry.current(value));
    const was = entry.read();
    const refusal = await entry.write(value);
    if (refusal) return refuse(409, refusal);
    const after = entry.read();
    const shown: Shown = change === undefined ? { before: was, after } : { after: change };
    const requestId = randomUUID();
    const language = deps.language(turn.threadId);
    const notSet = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const appSettingRequest: AppSettingRequest = { settingId: entry.id, label: entry.label, ...(shown.before === undefined ? {} : { before: shown.before }), after: shown.after, tier: entry.tier };
    store.appendMessage(turn.threadId, {
      role: "bot", kind: "options", ...from(bot, turn.threadId),
      card: { title: serverLine(language, "server.appSettings.changed", { label: entry.label }), subtitle: shown.before === undefined ? shown.after : `${notSet(shown.before)} → ${notSet(shown.after)}`,
        options: [], requestId, tool: TOOL, fixedOptions: true, appSettingRequest, answered: "allow", dismissed: true, autoApplied: true },
    });
    undoable.set(requestId, { entry, before, after: structuredClone(await entry.current(value)), target: value, ...(person ? { person } : {}) });
    appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "auto-approved", source: "app-settings" });
    const done = change === undefined ? `Changed ${entry.label} from ${text(was)} to ${text(after)}.` : `Done: ${change}. ${entry.label} now: ${text(after)}.`;
    return reply(200, { text: `${done} The user can undo it from the card in the conversation.` });
  }

  async function set(turn: Turn, body: Record<string, unknown>, ended?: AbortSignal) {
    const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
    if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (entry.tier === "owner-only") {
      const knownPlace = settingLocation(entry.where) !== entry.where;
      return refuse(403, knownPlace ? personOnly(entry.label, entry.where)
        : `${entry.label} is changed only by the owner, in ${entry.where}. Tell the user where to find it; do not try another way.`);
    }
    if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null) return refuse(403, "Settings change only in the owner's own conversation. This turn was not started by the owner here, so nothing changed; you may still read settings.");
    if (entry.tier === "secret") {
      if (body.value !== undefined) return refuse(400, `Never send a key or token as a value. Call set on ${entry.id} with no value: a secure card asks the user for it, and you never see it.`);
      const budget = spendWrite(turn);
      if (budget) return refuse(429, budget);
      const posted = await deps.requestCredential(bot, turn.threadId, { credentialId: entry.credentialId, reason: typeof body.reason === "string" ? body.reason : undefined });
      if (!posted.body.error && posted.body.alreadyConfigured === true) return reply(200, { text: `${entry.label} is already set. To replace it, the user changes it in ${settingLocation(entry.where)}.` });
      if (posted.status >= 300) return refuse(posted.status, String(posted.body.error ?? "The secure card could not be shown."));
      return reply(200, { text: `A secure card for ${entry.label} is ready in mymausbot. End this turn now and say in one line that you are waiting for it; mymausbot resumes you when the user saves it or declines. You never see the key.` });
    }
    const parsed = parseValue(entry, body.value);
    if (!parsed.success) return refuse(400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    if (entry.id === "bots.settings" && (parsed.data as { computer?: unknown }).computer === "local" && deps.automated?.(turn)) {
      return refuse(403, `A routine or automation can't keep a bot on this computer. Nothing changed: say in one line that the person can choose This computer under “Where ${bot.name} works” in Bot's screen, or ask you in their own chat.`);
    }
    const described = entry.describe?.(parsed.data);
    if (described && "refusal" in described) return refuse(409, described.refusal);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    if (entry.tier === "confirm") {
      const shown = described ? { after: described.change } : { before: entry.read(), after: entry.preview?.(parsed.data) ?? display(parsed.data) };
      return setConfirm(turn, bot, entry, parsed.data, shown, ended);
    }
    const picture = entry.fromFile ? await takePicture(turn, parsed.data) : { value: parsed.data };
    if ("refusal" in picture) return refuse(400, picture.refusal);
    const applied = await apply(turn, bot, entry, picture.value, described?.change);
    if (picture.stored && applied.status >= 300) deps.pictures?.discard(picture.stored);
    return applied;
  }

  /** A value naming a picture file by `path` goes on as the stored picture's `avatarUrl`; an empty path stays, to remove it. */
  async function takePicture(turn: Turn, value: unknown): Promise<{ value: unknown; stored?: string } | { refusal: string }> {
    const { path, ...rest } = value as { path?: unknown };
    if (typeof path !== "string" || !path) return { value };
    if (!deps.pictures) return { refusal: "Pictures can't be set from a file here." };
    const taken = await deps.pictures.take(turn, path);
    return "refusal" in taken ? taken : { value: { ...rest, avatarUrl: taken.avatarUrl }, stored: taken.avatarUrl };
  }

  /** A theme is the person's whose own message began the work, never a teammate's, an automated run's or a guest's. */
  async function theme(turn: Turn, body: Record<string, unknown>) {
    const themes = deps.themes;
    if (!themes) return refuse(404, "Themes are not available on this server.");
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    const person = deps.guestDriven(turn.threadId) || deps.automated?.(turn) ? null : themes.person(turn);
    if (!person) return refuse(403, "A theme changes only for the person who asked, in their own conversation. This turn was not started by them here, so nothing changed.");
    if (body.action === "theme") return themes.overview(person, body.id);
    if (body.action === "theme_history") return themes.history(person);
    const asked = body.action === "set_theme" ? themes.wanted(person, body) : body.action === "undo_theme" ? themes.undo(person, body) : null;
    if (asked && "error" in asked) return refuse(400, asked.error);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    return asked ? apply(turn, bot, themes.entry(person), asked.wear, asked.change, person) : themes.addAsset(turn, person, body);
  }

  /** Shows a setting's own control in the conversation. Security invariant: the reply and the row carry fixed words and
   * the card's id only; the control's code, link and address never pass through here. */
  function showCard(turn: Turn, body: Record<string, unknown>) {
    if (!isSettingsCardId(body.card)) return refuse(404, `No settings card ${JSON.stringify(body.card ?? null)}. Cards: ${SETTINGS_CARD_IDS.join(", ")}.`);
    const card = SETTINGS_CARDS[body.card];
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null) return refuse(403, "A settings card shows only in the owner's own conversation, when they asked. This turn was not started by the owner here, so nothing was shown.");
    if (!deps.cards?.here(body.card)) return reply(200, { text: cardElsewhere(card) });
    if (deps.connectorThread(bot.id, turn.threadId)?.group) return reply(200, { text: cardNotInRoom(card) });
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: card.text, settingsCard: { id: body.card } });
    return reply(200, { text: cardShownStatus(card, deps.cards.on(body.card)) });
  }

  return {
    async handle(body: Record<string, unknown>, turn: Turn, ended?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
      if (typeof body.action === "string" && THEME_ACTIONS.includes(body.action)) return theme(turn, body);
      if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null) return refuse(403, "Settings are available only in the owner's own conversation.");
      if (body.action === "find") {
        const query = typeof body.query === "string" ? body.query : "";
        const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
        if (hits.length) return reply(200, { text: JSON.stringify(hits) });
        const places = findPlaces(query);
        return reply(200, { text: `No setting you can change matches ${JSON.stringify(query)}.${places.length ? ` Where the person finds it in the app: ${places.join("; ")}.` : " Try other words, or use action places."}` });
      }
      if (body.action === "places") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        const places = query ? findPlaces(query) : [];
        return reply(200, { text: query ? (places.length ? places.join("\n") : `No place in the app matches ${JSON.stringify(query)}. Here is every place:\n${placesList()}`) : placesList() });
      }
      if (body.action === "get") {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}),
          change: entry.tier === "owner-only" ? `only the ${entry.where === settingLocation(entry.where) ? "owner" : "person"}, in ${settingLocation(entry.where)}` : entry.tier === "secret" ? "set with no value opens a secure card" : entry.tier === "confirm" ? "set shows the user a Change/Cancel card and waits" : "set applies at once, with Undo on the card" }) });
      }
      if (body.action === "set") return set(turn, body, ended);
      if (body.action === "show_card") return showCard(turn, body);
      return refuse(400, `action must be find, get, set, show_card, places, ${THEME_ACTIONS.join(", ")}.`);
    },

    undoPerson(requestId: string): string | undefined {
      return undoable.get(requestId)?.person;
    },

    /** The person's answer to a "Change X?" card; Allow counts only from an owner's review. */
    resolveAndSend(res: ServerResponse, args: { threadId: string; requestId: string; behavior: string }, ownerReview: boolean): boolean {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return false;
      if (args.behavior === "allow" && !ownerReview) {
        json(res, 403, { error: "Approve settings changes from the desktop app or a paired Full-access device. In a local browser, wait until every bot is idle." });
        return true;
      }
      const hold = held.get(args.requestId);
      if (!hold || hold.threadId !== args.threadId) {
        if (!current.answered) store.patchMessage(args.threadId, message.id, { card: { ...current, answered: "unavailable", dismissed: true } });
        json(res, 200, { ok: true, outcome: "unavailable" });
        return true;
      }
      if (hold.answered || hold.applying) {
        json(res, 200, { ok: true, outcome: "rejected", alreadySettled: true });
        return true;
      }
      const allowed = args.behavior === "allow";
      const bot = store.bot(hold.botId);
      store.patchMessage(args.threadId, message.id, { card: { ...current, answered: allowed ? "allow" : "deny" } });
      appendDecision(deps.dataDir, { threadId: args.threadId, requestId: args.requestId, botId: hold.botId, botName: bot?.name, tool: TOOL, summary: `${hold.entry.id}: ${current.subtitle}`, decision: allowed ? "user-approved" : "user-denied", source: "user" });
      if (!allowed) {
        settleHold(args.requestId, { kind: "denied" });
        json(res, 200, { ok: true, outcome: "rejected" });
        return true;
      }
      hold.applying = true;
      clearTimeout(hold.timer);
      void applyConfirmed(hold.entry, hold.value, hold.shown).then((outcome) => {
        settleHold(args.requestId, outcome);
      }, () => settleHold(args.requestId, { kind: "failed", error: "The setting change failed." }));
      json(res, 200, { ok: true, outcome: "allowed-once" });
      return true;
    },

    /** Undo on an applied card: restores the value read before the change, unless it changed since. */
    async undo(args: { threadId: string; requestId: string }): Promise<UndoResult> {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return { claimed: false };
      if (current.undone) return { claimed: true, state: "already_undone" };
      const change = undoable.get(args.requestId);
      if (!change || current.answered !== "allow" || current.appSettingRequest?.tier !== "safe" || change.entry.tier !== "safe") return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
      if (!isDeepStrictEqual(await change.entry.current(change.target), change.after)) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      const refusal = change.before === undefined && change.entry.id !== "bots.defaultModel"
        ? "The earlier value is not one that can be set back." : await change.entry.write(change.before);
      if (refusal) return { claimed: true, state: "invalid", error: refusal, status: 409 };
      undoable.delete(args.requestId);
      store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}
