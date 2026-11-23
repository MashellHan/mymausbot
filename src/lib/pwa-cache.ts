import { useEffect, useSyncExternalStore } from "react";
import type { Bot, ConfigStatus, Group } from "@/state/store";
import type { PwaAuthRecord } from "./pwa-transport";
import {
  OMB_PWA_OUTBOX_STORE,
  OMB_PWA_PREFS_STORE,
  OMB_PWA_SNAPSHOT_STORE,
  getPwaAuth,
  openPwaDb,
} from "./pwa-config";

export const PWA_SNAPSHOT_MESSAGE_LIMIT = 50;

export interface PwaPrefsRecord {
  ownerKey: string;
  pinnedBotId?: string;
  openPinnedOnLaunch: boolean;
  lastBotId?: string;
  lastThreadId?: string;
  updatedAt: number;
}

export interface PwaSnapshotRecord {
  ownerKey: string;
  savedAt: number;
  bots: Bot[];
  groups: Group[];
  sections: string[];
  config: ConfigStatus | null;
}

export interface PwaBootCache {
  ownerKey: string;
  snapshot: PwaSnapshotRecord;
  prefs: PwaPrefsRecord | null;
  outbox?: unknown[];
  queryBotId: string | null;
  defaultBotId?: string;
}

let bootCache: PwaBootCache | null = null;
let activePrefs: PwaPrefsRecord | null = null;
let loadedPrefsOwnerKey: string | null = null;
const prefsListeners = new Set<() => void>();

function notifyPrefsListeners(): void {
  for (const listener of prefsListeners) listener();
}

export function getActivePwaPrefs(): PwaPrefsRecord | null {
  const auth = getPwaAuth();
  if (!auth) return activePrefs;
  return activePrefs?.ownerKey === auth.ownerKey ? activePrefs : null;
}

export function setActivePwaPrefs(prefs: PwaPrefsRecord | null): void {
  activePrefs = prefs;
  loadedPrefsOwnerKey = prefs?.ownerKey ?? null;
  notifyPrefsListeners();
}

export function trimBotForSnapshot(bot: Bot, limit = PWA_SNAPSHOT_MESSAGE_LIMIT): Bot {
  const nonOptimistic = bot.messages.filter((message) => !message.id.startsWith("optimistic-"));
  const sliced = nonOptimistic.length > limit;
  const messages = sliced ? nonOptimistic.slice(-limit) : nonOptimistic;
  const tasks = bot.tasks?.map((task) => ({
    ...task,
    busy: false,
    turnStartedAt: undefined,
    waitingForTeammates: false,
  }));
  return {
    ...bot,
    messages,
    hasMore: Boolean(bot.hasMore || sliced),
    busy: false,
    turnStartedAt: null,
    waitingForTeammates: false,
    awaitingThreadSnapshot: undefined,
    switchingTo: undefined,
    ...(tasks ? { tasks } : {}),
  };
}

export function trimGroupForSnapshot(group: Group, limit = PWA_SNAPSHOT_MESSAGE_LIMIT): Group {
  const nonOptimistic = group.messages.filter((message) => !message.id.startsWith("optimistic-"));
  const sliced = nonOptimistic.length > limit;
  const messages = sliced ? nonOptimistic.slice(-limit) : nonOptimistic;
  const tasks = group.tasks?.map((task) => ({
    ...task,
    busyBotId: null,
    working: false,
  }));
  return {
    ...group,
    messages,
    hasMore: Boolean(group.hasMore || sliced),
    busyBotId: null,
    turnStartedAt: null,
    working: false,
    ...(tasks ? { tasks } : {}),
  };
}

function isValidPrefsRecord(value: unknown, ownerKey: string): value is PwaPrefsRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<PwaPrefsRecord>;
  return (
    r.ownerKey === ownerKey &&
    typeof r.openPinnedOnLaunch === "boolean" &&
    typeof r.updatedAt === "number"
  );
}

function isValidSnapshotRecord(value: unknown, ownerKey: string): value is PwaSnapshotRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<PwaSnapshotRecord>;
  return (
    r.ownerKey === ownerKey &&
    typeof r.savedAt === "number" &&
    Array.isArray(r.bots) &&
    Array.isArray(r.groups) &&
    Array.isArray(r.sections)
  );
}

export async function readPwaPrefs(ownerKey: string, idbFactory?: IDBFactory): Promise<PwaPrefsRecord | null> {
  if (!ownerKey) return null;
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return null;
  try {
    return await new Promise<PwaPrefsRecord | null>((resolve) => {
      const tx = db.transaction(OMB_PWA_PREFS_STORE, "readonly");
      const req = tx.objectStore(OMB_PWA_PREFS_STORE).get(ownerKey);
      req.onsuccess = () => resolve(isValidPrefsRecord(req.result, ownerKey) ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writePwaPrefs(prefs: PwaPrefsRecord, idbFactory?: IDBFactory): Promise<void> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OMB_PWA_PREFS_STORE, "readwrite");
      tx.objectStore(OMB_PWA_PREFS_STORE).put(prefs, prefs.ownerKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to persist PWA prefs"));
      tx.onabort = () => reject(tx.error ?? new Error("Failed to persist PWA prefs"));
    });
    if (getPwaAuth()?.ownerKey === prefs.ownerKey || activePrefs?.ownerKey === prefs.ownerKey) {
      setActivePwaPrefs(prefs);
    }
  } finally {
    db.close();
  }
}

export async function patchPwaPrefs(
  ownerKey: string,
  patch: Partial<Omit<PwaPrefsRecord, "ownerKey">>,
  idbFactory?: IDBFactory,
  now: () => number = Date.now,
): Promise<PwaPrefsRecord> {
  const existing =
    (activePrefs?.ownerKey === ownerKey ? activePrefs : null) ??
    (await readPwaPrefs(ownerKey, idbFactory));
  const next: PwaPrefsRecord = {
    ownerKey,
    openPinnedOnLaunch: existing?.openPinnedOnLaunch ?? true,
    ...(existing?.pinnedBotId ? { pinnedBotId: existing.pinnedBotId } : {}),
    ...(existing?.lastBotId ? { lastBotId: existing.lastBotId } : {}),
    ...(existing?.lastThreadId ? { lastThreadId: existing.lastThreadId } : {}),
    ...patch,
    updatedAt: patch.updatedAt ?? now(),
  };
  if (!next.pinnedBotId) delete next.pinnedBotId;
  if (!next.lastBotId) delete next.lastBotId;
  if (!next.lastThreadId) delete next.lastThreadId;
  await writePwaPrefs(next, idbFactory);
  return next;
}

export async function togglePinnedPwaBot(
  botId: string,
  ownerKey = getPwaAuth()?.ownerKey,
  idbFactory?: IDBFactory,
): Promise<PwaPrefsRecord | null> {
  if (!ownerKey || !botId) return null;
  const existing =
    (activePrefs?.ownerKey === ownerKey ? activePrefs : null) ??
    (await readPwaPrefs(ownerKey, idbFactory));
  const pinning = existing?.pinnedBotId !== botId;
  return patchPwaPrefs(
    ownerKey,
    pinning
      ? { pinnedBotId: botId, openPinnedOnLaunch: true }
      : { pinnedBotId: undefined },
    idbFactory,
  );
}

export function usePwaPrefs(): PwaPrefsRecord | null {
  const auth = getPwaAuth();
  const prefs = useSyncExternalStore(
    (listener) => {
      prefsListeners.add(listener);
      return () => prefsListeners.delete(listener);
    },
    getActivePwaPrefs,
    getActivePwaPrefs,
  );
  useEffect(() => {
    const ownerKey = auth?.ownerKey;
    if (!ownerKey || loadedPrefsOwnerKey === ownerKey) return;
    loadedPrefsOwnerKey = ownerKey;
    void readPwaPrefs(ownerKey).then((loaded) => {
      if (getPwaAuth()?.ownerKey !== ownerKey) return;
      if (loaded) setActivePwaPrefs(loaded);
    });
  }, [auth?.ownerKey]);
  return prefs;
}

export async function readPwaSnapshot(ownerKey: string, idbFactory?: IDBFactory): Promise<PwaSnapshotRecord | null> {
  if (!ownerKey) return null;
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return null;
  try {
    return await new Promise<PwaSnapshotRecord | null>((resolve) => {
      const tx = db.transaction(OMB_PWA_SNAPSHOT_STORE, "readonly");
      const req = tx.objectStore(OMB_PWA_SNAPSHOT_STORE).get(ownerKey);
      req.onsuccess = () => {
        if (!isValidSnapshotRecord(req.result, ownerKey)) {
          resolve(null);
          return;
        }
        resolve({
          ...req.result,
          bots: req.result.bots.map((bot) => trimBotForSnapshot(bot)),
          groups: req.result.groups.map((group) => trimGroupForSnapshot(group)),
        });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writePwaSnapshot(
  input: Omit<PwaSnapshotRecord, "savedAt"> & { savedAt?: number },
  idbFactory?: IDBFactory,
  limit = PWA_SNAPSHOT_MESSAGE_LIMIT,
): Promise<PwaSnapshotRecord> {
  const record: PwaSnapshotRecord = {
    ownerKey: input.ownerKey,
    savedAt: input.savedAt ?? Date.now(),
    bots: input.bots.map((bot) => trimBotForSnapshot(bot, limit)),
    groups: input.groups.map((group) => trimGroupForSnapshot(group, limit)),
    sections: [...input.sections],
    config: input.config ?? null,
  };
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return record;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OMB_PWA_SNAPSHOT_STORE, "readwrite");
      tx.objectStore(OMB_PWA_SNAPSHOT_STORE).put(record, record.ownerKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to persist PWA snapshot"));
      tx.onabort = () => reject(tx.error ?? new Error("Failed to persist PWA snapshot"));
    });
  } finally {
    db.close();
  }
  return record;
}

export async function deletePwaOwnerCache(ownerKey: string, idbFactory?: IDBFactory): Promise<void> {
  if (!ownerKey) return;
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction([OMB_PWA_PREFS_STORE, OMB_PWA_SNAPSHOT_STORE], "readwrite");
      tx.objectStore(OMB_PWA_PREFS_STORE).delete(ownerKey);
      tx.objectStore(OMB_PWA_SNAPSHOT_STORE).delete(ownerKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

export function readQueryBotFromLocation(search?: string): string | null {
  const rawSearch = search ?? (typeof location !== "undefined" ? location.search : "");
  if (!rawSearch) return null;
  const bot = new URLSearchParams(rawSearch).get("bot")?.trim() ?? "";
  return bot || null;
}

export function resolvePwaLaunchSelection(input: {
  queryBotId?: string | null;
  prefs?: PwaPrefsRecord | null;
  defaultBotId?: string | null;
  bots: readonly Pick<Bot, "id" | "hidden" | "threadId" | "tasks">[];
  groups?: readonly Pick<Group, "id" | "threadId" | "tasks">[];
}): { selectedId: string; threadId?: string; source: "query" | "pinned" | "last" | "default" | "first" } {
  const groups = input.groups ?? [];
  const hasVisibleBot = (id: string | undefined | null): id is string =>
    Boolean(id && input.bots.some((b) => b.id === id && !b.hidden));
  const hasConversation = (id: string | undefined | null): id is string =>
    Boolean(id && (input.bots.some((b) => b.id === id && !b.hidden) || groups.some((g) => g.id === id)));

  if (hasConversation(input.queryBotId)) {
    return { selectedId: input.queryBotId, source: "query" };
  }
  if (input.prefs?.openPinnedOnLaunch && hasVisibleBot(input.prefs.pinnedBotId)) {
    const pinnedBot = input.bots.find((b) => b.id === input.prefs?.pinnedBotId);
    const matchesLastThread =
      input.prefs.lastBotId === input.prefs.pinnedBotId &&
      input.prefs.lastThreadId &&
      (pinnedBot?.threadId === input.prefs.lastThreadId ||
        pinnedBot?.tasks?.some((t) => t.threadId === input.prefs?.lastThreadId));
    return {
      selectedId: input.prefs.pinnedBotId,
      ...(matchesLastThread ? { threadId: input.prefs.lastThreadId } : {}),
      source: "pinned",
    };
  }
  if (hasConversation(input.prefs?.lastBotId)) {
    const lastId = input.prefs!.lastBotId!;
    const bot = input.bots.find((b) => b.id === lastId);
    const group = groups.find((g) => g.id === lastId);
    const wantedThread = input.prefs?.lastThreadId;
    const threadValid = Boolean(
      wantedThread &&
        ((bot && (bot.threadId === wantedThread || bot.tasks?.some((t) => t.threadId === wantedThread))) ||
          (group && (group.threadId === wantedThread || group.tasks?.some((t) => t.threadId === wantedThread)))),
    );
    return {
      selectedId: lastId,
      ...(threadValid && wantedThread ? { threadId: wantedThread } : {}),
      source: "last",
    };
  }
  if (hasVisibleBot(input.defaultBotId)) {
    return { selectedId: input.defaultBotId, source: "default" };
  }
  const first = input.bots.find((b) => !b.hidden)?.id ?? input.bots[0]?.id ?? groups[0]?.id ?? "";
  return { selectedId: first, source: "first" };
}

async function readPwaOutboxRaw(idbFactory?: IDBFactory): Promise<unknown[]> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return [];
  try {
    if (!db.objectStoreNames?.contains?.(OMB_PWA_OUTBOX_STORE)) return [];
    return await new Promise<unknown[]>((resolve) => {
      const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readonly");
      const store = tx.objectStore(OMB_PWA_OUTBOX_STORE);
      if (typeof store.getAll !== "function") {
        resolve([]);
        return;
      }
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function preloadPwaBootCache(
  auth: Pick<PwaAuthRecord, "ownerKey" | "defaultBotId">,
  options: { idb?: IDBFactory; search?: string } = {},
): Promise<PwaBootCache | null> {
  const [snapshot, prefs, outbox] = await Promise.all([
    readPwaSnapshot(auth.ownerKey, options.idb),
    readPwaPrefs(auth.ownerKey, options.idb),
    readPwaOutboxRaw(options.idb),
  ]);
  if (prefs) setActivePwaPrefs(prefs);
  if (!snapshot) return null;
  const cache: PwaBootCache = {
    ownerKey: auth.ownerKey,
    snapshot,
    prefs,
    outbox,
    queryBotId: readQueryBotFromLocation(options.search),
    defaultBotId: auth.defaultBotId,
  };
  bootCache = cache;
  return cache;
}

export function setBootPwaCache(cache: PwaBootCache | null): void {
  bootCache = cache;
  if (cache?.prefs) setActivePwaPrefs(cache.prefs);
}

export function peekBootPwaCache(): PwaBootCache | null {
  return bootCache;
}

export function consumeBootPwaCache(): PwaBootCache | null {
  const current = bootCache;
  bootCache = null;
  return current;
}

export function resetPwaCacheForTests(): void {
  bootCache = null;
  activePrefs = null;
  loadedPrefsOwnerKey = null;
  notifyPrefsListeners();
}
