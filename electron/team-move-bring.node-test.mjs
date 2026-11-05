// A team's own page bringing a bot in from My Cloud: the team is the page's own by the Admin's word, the bots and their
// names come from My Cloud, and nothing moves until the person says so in main's own confirm.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bringableBots, installTeamMove, teamMoveConfirmWords } from "./team-move-main.mjs";

const HOME = "https://home.example.test", TEAM = "https://acme.example.test", OTHER = "https://other.example.test";
const state = { status: "connected", account: { id: "fixture-account" }, teams: [
  { id: "team-acme", name: "Acme", machine: { origin: TEAM, status: "ready" } },
  { id: "team-waiting", name: "Waiting", machine: { origin: OTHER, status: "provisioning" } },
] };
const BOTS = [
  { id: "maus-bot-1", name: "MausBot", defaultBot: {} },
  { id: "atlas-bot-1", name: "Atlas" },
  { id: "chief-bot-1", name: "Luna", chiefOfStaff: true },
  { id: "old-bot-01", name: "Hidden", hidden: true },
  { id: "gone-bot-01", name: "Gone", movedTo: { state: "moved", team: { id: "team-acme", name: "Acme" } } },
];

function fixture({ agrees = false, home = true, bots = BOTS, accountState = () => state, homeOrigin = () => HOME, pageOrigin = (event) => event.origin ?? null, confirm, fetchResponse, journalWrite, initialJournal = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-bring-"));
  const handlers = new Map(), asked = [], pairs = [], teamPairs = [];
  const journal = { value: structuredClone(initialJournal), read() { return this.value; }, write(next) { this.value = next; journalWrite?.(next); } };
  const move = installTeamMove({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: () => null,
    pageOrigin,
    confirmMove: async (words) => { asked.push(words); return confirm ? confirm(words) : agrees; },
    home: () => {
      if (!home) return null;
      const origin = homeOrigin();
      return { origin, grant: async () => { pairs.push("grant"); return { origin, code: "C" }; } };
    },
    account: () => ({ state: accountState, pairTeam: async (id) => { teamPairs.push(id); throw new Error("no team pairing in this test"); } }),
    file: () => join(dir, "send.json"), journalFile: () => join(dir, "moves.json"), journal,
    fetch: async (url, init) => {
      if (fetchResponse) return fetchResponse(url, init);
      if (String(url).endsWith("/api/auth/pair")) return new Response(JSON.stringify({ token: "omb_sess_fixture" }), { status: 200 });
      if (String(url).endsWith("/api/bots?messages=0")) return new Response(JSON.stringify({ bots }), { status: 200 });
      if (String(url).endsWith("/api/auth/logout")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ url, method: init?.method }), { status: 503 });
    },
  });
  return { handlers, asked, pairs, teamPairs, journal, move, done: () => { move.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const OWN = { origin: TEAM };

const ACCOUNTS = {
  a: { id: "fixture-account-a", origin: "https://home-a.example.test", bot: "Atlas A" },
  b: { id: "fixture-account-b", origin: "https://home-b.example.test", bot: "Atlas B" },
};
const pendingAMove = () => ({
  bot: { id: `atlas-${ACCOUNTS.a.id}`, name: "Atlas A" },
  team: { id: "team-acme", name: "Acme", origin: TEAM },
  source: { accountId: ACCOUNTS.a.id, origin: ACCOUNTS.a.origin },
  phase: "copy", startedAt: 1,
});
const accountBots = (owner) => [
  { id: `maus-${owner.id}`, name: "MausBot", defaultBot: {} },
  { id: `atlas-${owner.id}`, name: owner.bot },
];

function accountFixture({ confirm, pageOrigin, botsResponse, journalWrite, initialJournal, teams = () => state.teams } = {}) {
  let active = "a";
  let homeOverride = null;
  const requests = [];
  const current = () => ACCOUNTS[active];
  const setup = fixture({
    accountState: () => ({ status: "connected", account: { id: current().id }, teams: teams() }),
    homeOrigin: () => homeOverride ?? current().origin,
    ...(confirm ? { confirm } : {}),
    ...(pageOrigin ? { pageOrigin } : {}),
    ...(journalWrite ? { journalWrite } : {}),
    ...(initialJournal ? { initialJournal } : {}),
    fetchResponse: async (url) => {
      const parsed = new URL(url);
      const owner = Object.values(ACCOUNTS).find((candidate) => candidate.origin === parsed.origin);
      assert.ok(owner, "only synthetic Cloud origins are requested");
      requests.push({ origin: parsed.origin, path: parsed.pathname });
      if (parsed.pathname === "/api/auth/pair") return new Response(JSON.stringify({ token: "omb_sess_fixture" }), { status: 200 });
      if (parsed.pathname === "/api/bots") return botsResponse ? botsResponse(owner) : new Response(JSON.stringify({ bots: accountBots(owner) }), { status: 200 });
      if (parsed.pathname === "/api/auth/logout") return new Response("{}", { status: 200 });
      throw new Error(`unexpected synthetic route ${parsed.pathname}`);
    },
  });
  return { ...setup, requests, setAccount: (id) => { active = id; }, setHomeOrigin: (origin) => { homeOverride = origin; } };
}

test("lists My Cloud's bots to that team's own page, each with why it can't go, and to nobody else", async () => {
  const { handlers, done } = fixture();
  try {
    const list = handlers.get("cloud-send:team-bring");
    assert.deepEqual(await list(OWN), { team: { id: "team-acme", name: "Acme", ready: true }, bots: [
      { id: "maus-bot-1", name: "MausBot", stays: "default" }, { id: "atlas-bot-1", name: "Atlas" }, { id: "chief-bot-1", name: "Luna", stays: "chief" },
    ] });
    assert.deepEqual(await list({ origin: "https://stranger.example.test" }), { bots: [] }, "a page that isn't one of the person's teams");
    assert.deepEqual(await list({}), { bots: [] }, "a sender that isn't the window's own page");
  } finally { done(); }
});

test("nothing to list without a My Cloud, and a My Cloud that can't answer says nothing", async () => {
  const none = fixture({ home: false });
  try { assert.deepEqual((await none.handlers.get("cloud-send:team-bring")(OWN)).bots, []); } finally { none.done(); }
  const broken = fixture({ bots: null });
  try { assert.deepEqual((await broken.handlers.get("cloud-send:team-bring")(OWN)).bots, []); } finally { broken.done(); }
});

test("reads My Cloud once while the list is fresh: every read is one of the Admin's codes", async () => {
  const { handlers, pairs, done } = fixture();
  try {
    await handlers.get("cloud-send:team-bring")(OWN);
    await handlers.get("cloud-send:team-bring")(OWN);
    assert.equal(pairs.length, 1);
  } finally { done(); }
});

test("a fresh list never gives another signed-in account the previous account's bots", async () => {
  const { handlers, requests, setAccount, done } = accountFixture();
  try {
    const list = handlers.get("cloud-send:team-bring");
    assert.equal((await list(OWN)).bots[1].name, "Atlas A");
    setAccount("b");
    assert.equal((await list(OWN)).bots[1].name, "Atlas B");
    assert.equal((await list(OWN)).bots[1].name, "Atlas B");
    assert.deepEqual(requests.filter((request) => request.path === "/api/bots").map((request) => request.origin), [ACCOUNTS.a.origin, ACCOUNTS.b.origin]);
  } finally { done(); }
});

test("the same account does not reuse a list after My Cloud changes", async () => {
  const { handlers, requests, setHomeOrigin, done } = accountFixture();
  try {
    const list = handlers.get("cloud-send:team-bring");
    assert.equal((await list(OWN)).bots[1].name, "Atlas A");
    setHomeOrigin(ACCOUNTS.b.origin);
    assert.equal((await list(OWN)).bots[1].name, "Atlas B");
    assert.deepEqual(requests.filter((request) => request.path === "/api/bots").map((request) => request.origin), [ACCOUNTS.a.origin, ACCOUNTS.b.origin]);
  } finally { done(); }
});

test("a late answer from the previous account cannot refill the cache or reach the new account's page", { timeout: 10_000 }, async () => {
  let releaseA;
  const delayedA = new Promise((resolve) => { releaseA = resolve; });
  let sawA;
  const startedA = new Promise((resolve) => { sawA = resolve; });
  const { handlers, requests, setAccount, done } = accountFixture({
    botsResponse: async (owner) => {
      if (owner === ACCOUNTS.a) { sawA(); await delayedA; }
      return new Response(JSON.stringify({ bots: accountBots(owner) }), { status: 200 });
    },
  });
  try {
    const list = handlers.get("cloud-send:team-bring");
    const old = list(OWN);
    await startedA;
    setAccount("b");
    assert.equal((await list(OWN)).bots[1].name, "Atlas B");
    releaseA();
    assert.deepEqual(await old, { bots: [] });
    assert.equal((await list(OWN)).bots[1].name, "Atlas B");
    assert.deepEqual(requests.filter((request) => request.path === "/api/bots").map((request) => request.origin), [ACCOUNTS.a.origin, ACCOUNTS.b.origin]);
  } finally { releaseA(); done(); }
});

test("a list waiting on My Cloud answers nothing after its page changes", { timeout: 10_000 }, async () => {
  let activePage = TEAM, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { handlers, done } = accountFixture({
    pageOrigin: () => activePage,
    botsResponse: async (owner) => {
      entered();
      await delayed;
      return new Response(JSON.stringify({ bots: accountBots(owner) }), { status: 200 });
    },
  });
  try {
    const pending = handlers.get("cloud-send:team-bring")(OWN);
    await started;
    activePage = OTHER;
    release();
    assert.deepEqual(await pending, { bots: [] });
  } finally { release(); done(); }
});

for (const changed of ["account", "page"]) {
  test(`a confirmed bring does not start after its ${changed} changes`, { timeout: 10_000 }, async () => {
    let activePage = TEAM, answer;
    const confirmation = new Promise((resolve) => { answer = resolve; });
    let asked;
    const asking = new Promise((resolve) => { asked = resolve; });
    const { handlers, journal, setAccount, done } = accountFixture({
      pageOrigin: () => activePage,
      confirm: async () => { asked(); return confirmation; },
    });
    try {
      const pending = handlers.get("cloud-send:team-bring-move")(OWN, `atlas-${ACCOUNTS.a.id}`);
      await asking;
      if (changed === "account") setAccount("b");
      else activePage = OTHER;
      answer(true);
      await assert.rejects(pending, /account or team page changed/);
      assert.equal(journal.value, null);
    } finally { answer(false); done(); }
  });
}

test("a move keeps its original account and Cloud through deferred startup", async () => {
  let switchAccount, switched = false;
  const { handlers, journal, requests, setAccount, move, done } = accountFixture({
    confirm: async () => true,
    journalWrite: (value) => {
      if (!switched && value?.moves?.[0]?.phase === "copy") { switched = true; switchAccount(); }
    },
  });
  switchAccount = () => setAccount("b");
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, `atlas-${ACCOUNTS.a.id}`);
    assert.equal(answer.started, true);
    await move.kick();
    assert.deepEqual(journal.value.moves[0].source, { accountId: ACCOUNTS.a.id, origin: ACCOUNTS.a.origin });
    assert.equal(requests.some((request) => request.origin === ACCOUNTS.b.origin), false);
  } finally { done(); }
});

test("a foreign pending move stays untouched while the current account's move reaches its team", async () => {
  const old = pendingAMove();
  const { handlers, journal, requests, teamPairs, setAccount, move, done } = accountFixture({
    initialJournal: { v: 1, moves: [old] }, confirm: async () => true,
  });
  setAccount("b");
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, `atlas-${ACCOUNTS.b.id}`);
    await move.kick();
    assert.equal(answer.started, true);
    assert.deepEqual(journal.value.moves[0], old);
    assert.equal(requests.some((request) => request.origin === ACCOUNTS.a.origin), false);
    assert.deepEqual(teamPairs, ["team-acme"]);
  } finally { done(); }
});

test("another account's team list cannot stop a pending move before its owner returns", async () => {
  const old = pendingAMove();
  let otherAccount = false;
  const { journal, teamPairs, setAccount, move, done } = accountFixture({
    initialJournal: { v: 1, moves: [old] }, teams: () => otherAccount ? [] : state.teams,
  });
  try {
    otherAccount = true;
    setAccount("b");
    await move.kick();
    assert.deepEqual(journal.value.moves[0], old);
    otherAccount = false;
    setAccount("a");
    await move.kick();
    assert.deepEqual(teamPairs, ["team-acme"]);
  } finally { done(); }
});

test("retry, seen and a matching bot ID leave another account's journal record intact", async () => {
  const old = { ...pendingAMove(), failing: true, stopped: true, retryAt: 123 };
  const { handlers, journal, teamPairs, setAccount, move, done } = accountFixture({
    initialJournal: { v: 1, moves: [old] }, confirm: async () => true,
    botsResponse: async (owner) => new Response(JSON.stringify({ bots: [
      { id: `maus-${owner.id}`, name: "MausBot", defaultBot: {} },
      { id: old.bot.id, name: owner.bot },
    ] }), { status: 200 }),
  });
  setAccount("b");
  try {
    await move.retry();
    move.seen();
    assert.deepEqual(journal.value.moves, [old]);
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, old.bot.id);
    await move.kick();
    assert.equal(answer.started, true);
    assert.deepEqual(journal.value.moves[0], old);
    assert.equal(journal.value.moves[1].source.accountId, ACCOUNTS.b.id);
    assert.deepEqual(teamPairs, ["team-acme"]);
  } finally { done(); }
});

test("a late A copy result cannot rewrite B's independently confirmed move with the same bot ID", { timeout: 10_000 }, async () => {
  const old = pendingAMove();
  let releaseA;
  const delayedA = new Promise((resolve) => { releaseA = resolve; });
  let sawA;
  const startedA = new Promise((resolve) => { sawA = resolve; });
  const { handlers, journal, teamPairs, setAccount, move, done } = accountFixture({
    initialJournal: { v: 1, moves: [old] }, confirm: async () => true,
    botsResponse: async (owner) => {
      if (owner === ACCOUNTS.a) { sawA(); await delayedA; }
      return new Response(JSON.stringify({ bots: [
        { id: `maus-${owner.id}`, name: "MausBot", defaultBot: {} },
        { id: old.bot.id, name: owner.bot, threadId: "fixture-thread" },
      ] }), { status: 200 });
    },
  });
  let oldRun;
  try {
    oldRun = move.kick();
    await startedA;
    setAccount("b");
    const started = await handlers.get("cloud-send:team-bring-move")(OWN, old.bot.id);
    const beforeB = structuredClone(journal.value.moves.find((entry) => entry.source?.accountId === ACCOUNTS.b.id));
    releaseA();
    await oldRun;
    const afterA = journal.value.moves.find((entry) => entry.source?.accountId === ACCOUNTS.a.id);
    const afterB = journal.value.moves.find((entry) => entry.source?.accountId === ACCOUNTS.b.id);
    assert.equal(started.started, true);
    assert.deepEqual(afterA, old);
    assert.equal(beforeB.source.accountId, ACCOUNTS.b.id);
    assert.notEqual(afterB?.error, "My Cloud sign-in changed. Try again.");
    assert.deepEqual(teamPairs, ["team-acme"]);
  } finally { releaseA(); if (oldRun) await oldRun; done(); }
});

test("bring status and a canceled confirmation project only the current source and team", async () => {
  const old = pendingAMove();
  let otherTeam = false;
  const { handlers, setAccount, move, done } = accountFixture({
    initialJournal: { v: 1, moves: [old] },
    teams: () => otherTeam ? [{ id: "team-b", name: "Team B", machine: { origin: OTHER, status: "ready" } }] : state.teams,
  });
  try {
    assert.equal(handlers.get("cloud-send:team-bring-status")(OWN)?.bot.id, old.bot.id);
    setAccount("b");
    assert.equal(handlers.get("cloud-send:team-bring-status")(OWN), null);
    assert.equal(move.view(), null);
    otherTeam = true;
    assert.equal(handlers.get("cloud-send:team-bring-status")({ origin: OTHER }), null);
    const canceled = await handlers.get("cloud-send:team-bring-move")({ origin: OTHER }, `atlas-${ACCOUNTS.b.id}`);
    assert.deepEqual(canceled, { started: false, move: null });
  } finally { done(); }
});

test("losing team membership during confirmation still blocks another Cloud", { timeout: 10_000 }, async () => {
  let member = true, answer;
  const confirmation = new Promise((resolve) => { answer = resolve; });
  let asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const { handlers, requests, journal, setAccount, done } = accountFixture({
    teams: () => member ? state.teams : [],
    confirm: async () => { asked(); return confirmation; },
  });
  try {
    const pending = handlers.get("cloud-send:team-bring-move")(OWN, `atlas-${ACCOUNTS.a.id}`);
    await asking;
    member = false;
    setAccount("b");
    answer(true);
    await assert.rejects(pending, /account or team page changed/);
    assert.equal(requests.some((request) => request.origin === ACCOUNTS.b.origin), false);
    assert.equal(journal.value, null);
  } finally { answer(false); done(); }
});

test("moves nothing until the person agrees in main's own confirm, which says there's no way back and what stays", async () => {
  const { handlers, asked, journal, done } = fixture({ agrees: false });
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, "atlas-bot-1");
    assert.deepEqual(answer, { started: false, move: null });
    assert.equal(journal.value, null);
    assert.equal(asked[0].message, "Move Atlas to Acme?");
    assert.match(asked[0].detail, /no way back/);
    assert.match(asked[0].detail, /what Atlas remembers, your connections, and MausBot/);
    assert.deepEqual(asked[0].buttons, ["Move to Acme", "Cancel"]);
  } finally { done(); }
});

test("moves the bot once they agree, into the page's own team, under the name My Cloud has", async () => {
  const { handlers, journal, done } = fixture({ agrees: true });
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, "atlas-bot-1", "a name from the page");
    assert.equal(answer.started, true);
    assert.deepEqual(journal.value.moves.map((move) => [move.bot.id, move.bot.name, move.team.id]), [["atlas-bot-1", "Atlas", "team-acme"]]);
    assert.deepEqual(journal.value.moves[0].source, { accountId: "fixture-account", origin: HOME });
    assert.deepEqual(await handlers.get("cloud-send:team-bring-status")(OWN), { bot: { id: "atlas-bot-1", name: "Atlas" }, team: { id: "team-acme", name: "Acme" }, phase: "moving" });
    assert.equal(await handlers.get("cloud-send:team-bring-status")({ origin: OTHER }), null, "another team's page reads nothing of it");
  } finally { done(); }
});

test("refuses what can't go, a bot My Cloud doesn't have, a team not ready and a page that isn't the team's, before asking", async () => {
  const { handlers, asked, journal, done } = fixture({ agrees: true });
  try {
    const move = handlers.get("cloud-send:team-bring-move");
    await assert.rejects(move(OWN, "maus-bot-1"), /Choose one of your bots/);
    await assert.rejects(move(OWN, "chief-bot-1"), /Choose one of your bots/);
    await assert.rejects(move(OWN, "elsewhere-1"), /Choose one of your bots/);
    await assert.rejects(move({ origin: OTHER }, "atlas-bot-1"), /Open the team/);
    await assert.rejects(move({}, "atlas-bot-1"), /Open the team/);
    assert.deepEqual(asked, []);
    assert.equal(journal.value, null);
  } finally { done(); }
});

test("keeps the last bot on My Cloud, and leaves out what already left", () => {
  assert.deepEqual(bringableBots([{ id: "atlas-bot-1", name: "Atlas" }]), [{ id: "atlas-bot-1", name: "Atlas", stays: "last" }]);
  assert.deepEqual(bringableBots([{ id: "gone-bot-01", name: "Gone", movedTo: {} }, { id: "atlas-bot-1", name: "Atlas" }, { id: "x y", name: "Bad id" }]), [{ id: "atlas-bot-1", name: "Atlas", stays: "last" }]);
  assert.deepEqual(bringableBots(null), []);
});

test("its confirm says what the page's confirm says, word for word", () => {
  const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"));
  const fill = (key) => en[key].replaceAll("{bot}", "Atlas").replaceAll("{team}", "Acme");
  const words = teamMoveConfirmWords({ bot: "Atlas", team: "Acme" });
  assert.equal(words.message, fill("teamMove.title"));
  assert.equal(words.buttons[0], fill("teamMove.confirm"));
  for (const key of ["teamMove.everyone", "teamMove.goes", "teamMove.private", "teamMove.staysOnMyCloud", "teamMove.noWayBack"]) assert.ok(words.detail.includes(fill(key)), key);
});
