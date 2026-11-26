import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationRange, MAIN_EVIDENCE_QUERY, MAIN_HISTORY_LIMIT } from "./ci-integration.mjs";

// The ci.yml jobs a pull request runs only when its change can affect them;
// `static` and the `CI` gate always run. Besides these job ids a scope's checks
// name "build" (static's typecheck, Electron syntax check and UI build) and the
// vitest job's parts: "linux-tests", "host-tests" (Windows, and macOS where the
// event runs it), and the subsets in VITEST_SUBSETS.
export const SELECTABLE_JOBS = [
  "vitest", "behavior-evals", "electron-smokes", "foss", "control-plane", "ui-smoke", "browser-identity", "browser-driver", "relay", "pwa-relay",
];

// The server imports Electron and renderer modules, and the macOS smokes run
// the packaged server inside Electron, so a server change and a desktop change
// can affect the same checks.
const SERVER_CHECKS = [
  "build", "host-tests", "behavior-evals", "foss", "electron-smokes", "ui-smoke", "browser-identity", "browser-driver",
];
const EVERY_CHECK = [...SERVER_CHECKS, "control-plane", "relay", "pwa-relay"];

/** What a pull request's change in each area can affect. */
export const AREA_CHECKS = {
  docs: ["docs-tests"],
  locales: ["build", "locale-tests"],
  web: ["build", "host-tests", "ui-smoke"],
  "script-tests": ["host-tests", "ui-smoke", "browser-identity"],
  server: SERVER_CHECKS,
  desktop: SERVER_CHECKS,
  "windows-computer-control": SERVER_CHECKS,
  "control-plane": ["control-plane"],
  broker: ["build", "control-plane"],
  // The announcements file and its pictures: static validates them (scripts/check-announcements.mjs), and nothing else
  // reads them but the server's bundled copy, which that check covers.
  announcements: [],
  // The relay is its own package with its own lockfile; nothing outside relay/ reaches it except the shared vectors,
  // which it keeps a pinned copy of.
  relay: ["relay"],
  "pwa-relay": ["pwa-relay"],
  "e2e-vectors": [...SERVER_CHECKS, "relay"],
  everything: EVERY_CHECK,
};

/** The vitest files a pull request runs on Linux when it runs no full Linux
 * shards, as vitest filters. Locale tests: every test that reads a translation
 * other than English (the renderer's files take about nine minutes in one
 * process), with the Electron node tests, which compare their own copy of some
 * strings with every catalog, and the server's tests of its lines in other
 * languages (they load server/server-line-packs.ts). Docs tests: every test that
 * reads the docs. */
export const VITEST_SUBSETS = {
  "locale-tests": {
    part: "locale tests",
    files: [
      "src/",
      "electron/cua-launch.test.mjs",
      "electron/cua-watch-restart.test.mjs",
      "electron/cua-windows-isolation.test.mjs",
      "electron/menu.test.mjs",
      "electron/updater.test.mjs",
      "scripts/generate-locale.test.mjs",
      "scripts/testing/bot-tools-ui.e2e.test.ts",
      "scripts/testing/cloud-send-fixture.test.ts",
      "scripts/testing/key-readback.e2e.test.ts",
      "scripts/testing/one-workspace-ui.e2e.test.ts",
      "scripts/testing/rail-profile-ui.e2e.test.ts",
      "scripts/testing/secret-card-descriptions.test.ts",
      "scripts/testing/team-conversation-share-ui.e2e.test.ts",
      "scripts/testing/team-own-chat.e2e.test.ts",
      "scripts/testing/team-private-default-ui.e2e.test.ts",
      "scripts/testing/team-side-switch-ui.e2e.test.ts",
      "server/body-thread-guards.e2e.test.ts",
      "server/client-notifications.e2e.test.ts",
      "server/cloud-connections.e2e.test.ts",
      "server/cloud-lending-browser.e2e.test.ts",
      "server/cloud-lending-chrome.e2e.test.ts",
      "server/cloud-lending-memory.e2e.test.ts",
      "server/cloud-lending.e2e.test.ts",
      "server/cloud-lent-mcp.e2e.test.ts",
      "server/cloud-personal-slack.e2e.test.ts",
      "server/cloud-send-kinds.e2e.test.ts",
      "server/cloud-send-move.e2e.test.ts",
      "server/cloud-send-rooms.e2e.test.ts",
      "server/cloud-send-routine-merge.e2e.test.ts",
      "server/cloud-send-store.e2e.test.ts",
      "server/cloud-send.e2e.test.ts",
      "server/cloud-sync.e2e.test.ts",
      "server/cloud-team-asker-owns.e2e.test.ts",
      "server/cloud-team-away.e2e.test.ts",
      "server/cloud-team-bitwarden.e2e.test.ts",
      "server/cloud-team-box-audience.e2e.test.ts",
      "server/cloud-team-browser.e2e.test.ts",
      "server/cloud-team-connections.e2e.test.ts",
      "server/cloud-team-conversation-share.e2e.test.ts",
      "server/cloud-team-engine-homes.e2e.test.ts",
      "server/cloud-team-files.e2e.test.ts",
      "server/cloud-team-gateway-mcp.e2e.test.ts",
      "server/cloud-team-inbox.e2e.test.ts",
      "server/cloud-team-included-hosting.e2e.test.ts",
      "server/cloud-team-mausbot-reach.e2e.test.ts",
      "server/cloud-team-member-secrets.e2e.test.ts",
      "server/cloud-team-new-chat-private.e2e.test.ts",
      "server/cloud-team-onepassword.e2e.test.ts",
      "server/cloud-team-open-reach.e2e.test.ts",
      "server/cloud-team-own-key-apps.e2e.test.ts",
      "server/cloud-team-owners.e2e.test.ts",
      "server/cloud-team-people.e2e.test.ts",
      "server/cloud-team-per-person.e2e.test.ts",
      "server/cloud-team-phones.e2e.test.ts",
      "server/cloud-team-pictures.e2e.test.ts",
      "server/cloud-team-presence.e2e.test.ts",
      "server/cloud-team-privacy-holes.e2e.test.ts",
      "server/cloud-team-private-default.e2e.test.ts",
      "server/cloud-team-private.e2e.test.ts",
      "server/cloud-team-profile.e2e.test.ts",
      "server/cloud-team-slack.e2e.test.ts",
      "server/cloud-team-published-apps.e2e.test.ts",
      "server/cloud-team-requests.e2e.test.ts",
      "server/cloud-team-routines.e2e.test.ts",
      "server/cloud-team-setup-request.e2e.test.ts",
      "server/cloud-team-templates.e2e.test.ts",
      "server/cloud-team.e2e.test.ts",
      "server/host/brief-words.test.ts",
      "server/host/lending-lifts.test.ts",
      "server/lent-folders.e2e.test.ts",
      "server/move-chosen-bots.e2e.test.ts",
      "server/one-home-keep.e2e.test.ts",
      "server/one-home-outdated.e2e.test.ts",
      "server/one-home-retry.e2e.test.ts",
      "server/one-home-session.e2e.test.ts",
      "server/one-home-trial-key.e2e.test.ts",
      "server/one-home-two-desks.e2e.test.ts",
      "server/one-home.e2e.test.ts",
      "server/parked-cards.e2e.test.ts",
      "server/peer-approval.test.ts",
      "server/question-cards.e2e.test.ts",
      "server/shared-computers.e2e.test.ts",
      "server/shared-computers.gate.test.ts",
      "server/team-move.e2e.test.ts",
      "server/team-welcome.e2e.test.ts",
      "server/use-my-mac.e2e.test.ts",
      "server/workspace-banner.e2e.test.ts",
      "scripts/server-locale-plugin.test.ts",
      "server/server-lines.test.ts",
      "server/host/devs-reports.test.ts",
      "server/automation-reports.test.ts",
      "server/incidents.test.ts",
      "server/routine-run-card.test.ts",
      "server/host/chief-notices-retry.test.ts",
      "server/connector-card-text.test.ts",
      "server/host/secret-cards.test.ts",
      "server/notify.test.ts",
      "server/room-lines.test.ts",
      "server/post-to-room.test.ts",
      "server/teammate-lines.test.ts",
      "server/chat-notices.test.ts",
      "server/recall-disclosure.test.ts",
      "server/routine-cron-text.test.ts",
      "server/routine-cron-text-zh.test.ts",
      "server/routine-requests.test.ts",
      "server/cloud-send-arrived.test.ts",
      "server/cloud-team-bot-access.e2e.test.ts",
      "server/cloud-team-one-answer.e2e.test.ts",
      "server/cloud-team-preference.e2e.test.ts",
      "server/cloud-team-rules.e2e.test.ts",
      "server/cloud-team-rules-running-turn.e2e.test.ts",
      "server/outside-work-threads.e2e.test.ts",
      "server/own-home.e2e.test.ts",
      "server/places-elsewhere.e2e.test.ts",
      "server/question-routing.e2e.test.ts",
      "server/team-protocol.e2e.test.ts",
      "server/team-small-fixes.e2e.test.ts",
      "server/team-mausbot-followup.e2e.test.ts",
      "server/team-no-ai.e2e.test.ts",
      "server/team-phone-data.e2e.test.ts",
      "server/team-refused-handoff.e2e.test.ts",
      "server/two-places.e2e.test.ts",
      "scripts/ci-workflow.test.ts",
      "scripts/pre-push-check.test.ts",
      "server/host/wait-words.test.ts",
      "server/place-inbox.e2e.test.ts",
      "server/bot-api-team.e2e.test.ts",
      "server/cloud-team-conversation-share.e2e.test.ts",
      "server/cloud-team-first-look.e2e.test.ts",
      "server/cloud-team-mausbot-own-chat.e2e.test.ts",
      "server/connector-stayed.e2e.test.ts",
      "server/email/host.test.ts",
      "server/email/inline-images.test.ts",
      "server/host/outside-lineage.test.ts",
      "server/memory-move.test.ts",
      "server/outside-lineage.e2e.test.ts",
      "server/same-name-mentions.e2e.test.ts",
      "server/skill-switch.test.ts",
    ],
    shards: 2,
    nodeTests: true,
  },
  "docs-tests": {
    part: "docs tests",
    files: ["scripts/testing/analytics-docs.test.ts", "server/model-providers-docs.test.ts", "src/locales/vocabulary.test.ts"],
    shards: 1,
    nodeTests: false,
  },
};

/** Renderer files that also run outside the renderer: the server imports
 * them, or the macOS app-frame smoke bundles them. ci-scope.test.ts holds this
 * equal to the import graph. The language packs are left out, though the
 * server reads their "server." lines: a change to English runs every Linux test,
 * and one to another language runs every test that reads it (the locale tests). */
export const SRC_OUTSIDE_RENDERER = [
  "src/components/app/app-frame-host.ts",
  "src/lib/citations.ts",
  "src/lib/composer-attachments.ts",
  "src/lib/pwa-dpop.ts",
  "src/lib/pwa-transport.ts",
  "src/lib/random-uuid.ts",
  "src/lib/receipts.ts",
];

export const DOCS = /^(?:[^/]+\.md|docs\/.+\.md|\.agents\/team\/(?:playbook|roles\/[^/]+)\.md|\.github\/FUNDING\.yml)$/;

// The first matching rule names a path's area; a path no rule names can affect
// anything. English is the source every test reads, so en.json is web.
const AREAS = [
  [DOCS, "docs"],
  [/^(?:apps\/)?docs\//, "docs"],
  [/^scripts\/.+\.test\.[cm]?[jt]sx?$/, "script-tests"],
  [/^src\/locales\/(?:(?!en\.json$)[^/]+\.json|[^/]+\.test\.ts)$/, "locales"],
  [/^(?:src|public)\/|^[^/]+-preview\.html$/, "web"],
  [/^companion\/src\/e2e\/vectors\//, "e2e-vectors"],
  [/^cloudflare\/composio-broker\//, "broker"],
  [/^(?:server|shared|packages\/phone-protocol|enterprise|companion|evals|skills|deploy)\/|^(?:Dockerfile|\.dockerignore|compose\.yaml)$/, "server"],
  [/^electron\/(?:cua|cua-failure|cua-connection|capabilities|screen-status|shared-cua-connection|shared-computer-access|lent-screen-tools|lent-screen-failures|paced-typing)\.[cm]js$/, "windows-computer-control"],
  [/^(?:electron|build)\/|^(?:electron-builder\.yml|index\.html|rail\.html)$/, "desktop"],
  [/^cloudflare\/control-plane\//, "control-plane"],
  [/^announcements\//, "announcements"],
  [/^relay\//, "relay"],
  [/^pwa-relay\//, "pwa-relay"],
];

export function areaOf(file) {
  if (typeof file !== "string" || /\p{Cc}/u.test(file) || file.split("/").some((part) => !part || part === "." || part === "..")) {
    return "everything";
  }
  if (SRC_OUTSIDE_RENDERER.includes(file)) return "server";
  return AREAS.find(([pattern]) => pattern.test(file))?.[1] ?? "everything";
}

export const FULL_SCOPE = { areas: ["everything"], checks: [...EVERY_CHECK].sort() };

/** Main and merge-group checks include the full macOS Vitest file set. */
export const MAIN_SCOPE = {
  areas: ["main"],
  checks: [
    "behavior-evals", "browser-identity", "build", "control-plane", "electron-smokes", "foss", "host-tests", "ui-smoke",
  ],
};

/** A pull request's areas and the checks they select, from its changed files. */
export function selectCiScope(files) {
  const areas = Array.isArray(files) && files.length > 0 ? [...new Set(files.map(areaOf))].sort() : ["everything"];
  if (areas.includes("everything")) return FULL_SCOPE;
  return { areas, checks: [...new Set(areas.flatMap((area) => AREA_CHECKS[area]))].sort() };
}

export const POLICY_PATH = "scripts/testing/check-policy.json";
export const POLICY_CHANGE = /^(?:\.github\/|scripts\/(?:ci-|check\.|qa\/|testing\/(?:check-policy|ci-retry|host-e2e|duration-sequencer|vitest-shard))|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*|\.npmrc|\.node-version)$)/;
export const SENSITIVE_PATH = /^(?:shared\/|packages\/phone-protocol\/|server\/(?:drivers?\/|host\/|routes\/|local-|request-auth|guarded|store|message-db|turn-|safety|pairing|secret)|electron\/|companion\/|enterprise\/)/;
const SENSITIVE_LINE = /\b(?:auth|authorization|permission|credential|secret|redact|token|password|localStorage|sessionStorage|fetch|WebSocket|postMessage|ipcRenderer|persist|migration|dispatch|cancel|spawn|exec)\b/i;
const SERVER_CORE_AREAS = new Set(["server", "desktop", "windows-computer-control", "e2e-vectors", "everything"]);
const CI_VERIFY_PATH = /^(?:\.github\/|scripts\/|docs\/|[^/]+\.md$|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*|\.npmrc|\.node-version)$|src\/locales\/|electron\/)/;
export const SAFE_TEST_PATH = /^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.test\.[cm]?[jt]sx?$/;
export const FAST_AFFECTED_LIMIT = 4;
export const SETTINGS_PLACES_TEST = "src/components/settings/settings-places.test.ts";
const SETTINGS_PLACES_INPUTS = new Set([
  SETTINGS_PLACES_TEST, "src/components/settings/settings-index.ts", "src/components/settings/settings-places.ts",
  "src/locales/en.json", "src/locales/index.ts", "shared/settings-places.ts", "scripts/gen-settings-places.ts",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "vite.config.ts",
]);
const RELAY_NATIVE_TEST = /^relay\/test\/.*\.test\.ts$/;
const PWA_RELAY_NATIVE_TEST = /^pwa-relay\/test\/.*\.test\.ts$/;
const BROKER_OWN_TEST = /^cloudflare\/composio-broker\/src\/.*\.test\.ts$/;
const FAST_EXPENSIVE_TEST = /^(?:scripts\/testing\/.*\.e2e\.test\.ts|server\/browser\/.*\.e2e\.test\.ts|electron\/.*\.electron\.test\.mjs|server\/index\.test\.ts|relay\/test\/.*\.test\.ts|pwa-relay\/test\/.*\.test\.ts)$/;
const unique = (values) => [...new Set(values)].sort();

export function readCheckPolicy(text = readFileSync(POLICY_PATH, "utf8"), present = existsSync) {
  const policy = JSON.parse(text);
  const hasServerCore = policy.serverCore !== undefined;
  const serverCore = hasServerCore ? policy.serverCore : [];
  const tests = [...(policy.core ?? []), ...(Array.isArray(serverCore) ? serverCore : []), ...(policy.guards ?? []), ...(policy.areas ?? []).flatMap((area) => area.tests ?? [])];
  if (policy.version !== 1 || !policy.core?.length || (hasServerCore && (!Array.isArray(serverCore) || !serverCore.length))
    || !policy.guards?.length || !Array.isArray(policy.areas)
    || tests.some((file) => !SAFE_TEST_PATH.test(file) || !present(file))
    || policy.areas.some((area) => !/^[a-z][a-z-]+$/.test(area.id) || !area.sources?.length || !area.tests?.length
      || typeof area.admitted !== "boolean" || area.sources.some((file) => areaOf(file) === "everything"))
    || new Set(policy.areas.map((area) => area.id)).size !== policy.areas.length) {
    throw new Error("Invalid check policy or missing required test");
  }
  return policy;
}

export function selectCheckPlan({ files, policy, labels = [], lines = [], mode = "legacy", fastPr = false, focusedPush = false, qa = { healthy: false, reason: "QA state unavailable" }, present = existsSync }) {
  const baseline = selectCiScope(files);
  const changed = Array.isArray(files) ? files : [];
  const areas = policy.areas.filter((area) => area.sources.some((file) => changed.includes(file)));
  const mapped = new Set(areas.flatMap((area) => [...area.sources, ...area.tests]));
  const direct = changed.flatMap((file) => {
    if (SAFE_TEST_PATH.test(file)) return present(file) ? [file] : [];
    const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
    return [`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.test.mjs`, `${stem}.e2e.test.ts`].filter(present);
  });
  const affected = unique([...areas.flatMap((area) => area.tests), ...direct]);
  const focused = fastPr || focusedPush;
  const settingsPlaces = !Array.isArray(files) || changed.some((file) => SETTINGS_PLACES_INPUTS.has(file));
  const ciVerify = !Array.isArray(files) || !changed.length || changed.some((file) => CI_VERIFY_PATH.test(file));
  const nativeRelay = changed.some((file) => file.startsWith("relay/"));
  const nativePwaRelay = changed.some((file) => file.startsWith("pwa-relay/"));
  const vitestAffected = affected.filter((file) => !RELAY_NATIVE_TEST.test(file) && !PWA_RELAY_NATIVE_TEST.test(file) && !BROKER_OWN_TEST.test(file));
  const sensitiveLine = lines.some((line) => /^[+-](?![+-]{2})/.test(line) && SENSITIVE_LINE.test(line));
  const sensitivePath = changed.some((file) => SENSITIVE_PATH.test(file));
  const reasons = [];
  if (["ci:full", "qa:repair", "windows"].some((label) => labels.includes(label))) reasons.push("explicit full validation request");
  if (!changed.length || baseline.areas.includes("everything")) reasons.push("unknown or empty change scope");
  if (changed.some((file) => POLICY_CHANGE.test(file))) reasons.push("CI, policy, dependency or toolchain change");
  if (sensitivePath || sensitiveLine) {
    reasons.push(focused ? "sensitive contract: remaining coverage in full QA" : "sensitive contract: retain full validation");
  }
  if (baseline.areas.length >= 3 && !baseline.areas.every((area) => area === "docs" || area === "locales")) reasons.push("broad integration change");
  const full = !focused && reasons.length > 0;
  const mappedArea = areas.length > 0 && changed.every((file) => mapped.has(file) && present(file) || DOCS.test(file));
  const candidate = !focused && !full && mappedArea;
  const qaBlocked = (qa.blockedAreas ?? []).some((area) => area === "global" || areas.some((hit) => hit.id === area));
  const admitted = candidate && areas.every((area) => area.admitted);
  const reduced = mode === "tiered" && admitted && qa.healthy && !qaBlocked;
  if (candidate && !admitted) reasons.push("area awaiting pilot evidence");
  if (candidate && (!qa.healthy || qaBlocked)) reasons.push(qa.reason || "untriaged or held QA findings affect this area");
  if (candidate && mode !== "tiered") reasons.push(`${mode}: retain existing coverage`);
  const docs = changed.length > 0 && changed.every((file) => areaOf(file) === "docs");
  const serverCore = policy.serverCore ?? [];
  const allCore = unique([...policy.core, ...serverCore]);
  const needsServerCore = changed.some((file) => SERVER_CORE_AREAS.has(areaOf(file)) || SENSITIVE_PATH.test(file)) || sensitiveLine;
  const fastCore = needsServerCore ? allCore : policy.core;
  const filesToRun = unique([...allCore, ...vitestAffected]);
  if (filesToRun.some((file) => !SAFE_TEST_PATH.test(file) || !present(file))) throw new Error("Unsafe or missing selected test");
  const additional = [...new Set([...unique(direct), ...affected])].filter((file) => !allCore.includes(file)
    && !policy.guards.includes(file) && !/^scripts\/qa\/.*\.test\.ts$/.test(file)
    && file !== "scripts/release-ci.test.ts" && file !== SETTINGS_PLACES_TEST);
  const portable = additional.filter((file) => !FAST_EXPENSIVE_TEST.test(file) && !BROKER_OWN_TEST.test(file));
  const fastFiles = unique([...fastCore, ...portable.slice(0, FAST_AFFECTED_LIMIT)]);
  const deferred = unique(additional.filter((file) => !fastFiles.includes(file) && !BROKER_OWN_TEST.test(file)));
  const controlPlane = changed.some((file) => ["control-plane", "broker"].includes(areaOf(file)));
  const pwaRelay = changed.some((file) => areaOf(file) === "pwa-relay");
  const fastChecks = ["build", ...(controlPlane ? ["control-plane"] : []), ...(pwaRelay ? ["pwa-relay"] : [])];
  return {
    version: policy.version, mode, files: changed, areas: baseline.areas, fastAreas: areas.map((area) => area.id),
    holdAreas: !full && mappedArea ? areas.map((area) => area.id) : ["global"],
    full, candidate, admitted, reduced, fast: fastPr, focusedPush, settingsPlaces, ciVerify, needsServerCore, reasons,
    scope: focused ? { areas: baseline.areas, checks: fastChecks, files: fastFiles }
      : full ? FULL_SCOPE : reduced ? { areas: areas.map((area) => area.id), checks: ["build", "core-tests"], files: filesToRun } : baseline,
    edit: docs ? [...VITEST_SUBSETS["docs-tests"].files, ...policy.guards] : vitestAffected,
    ready: docs ? unique([...VITEST_SUBSETS["docs-tests"].files, ...policy.guards]) : unique([...filesToRun, ...policy.guards]),
    core: filesToRun, fastFiles, deferred, nativeRelay, nativePwaRelay,
  };
}

/** The pull request label that runs the Windows jobs whatever the change. */
export const WINDOWS_LABEL = "windows";

/** Paths whose change can break Windows first: Windows by name, the desktop app and its installer, the dependencies,
 * the scripts that build, package or smoke the app, and what decides how the Windows shards run. */
export const WINDOWS_PATH = new RegExp([
  String.raw`(?:^|[/._-])(?:win|win32|win64|windows|nsis|powershell|pwsh)(?:[/._-]|$)`,
  String.raw`\.(?:ps1|psm1|psd1|cmd|bat|exe|msi|nsh|nsi)$`,
  String.raw`^(?:electron|build|third_party)/`,
  String.raw`^(?:electron-builder\.yml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.gitattributes|vite\.config\.ts)$`,
  String.raw`^\.github/workflows/ci\.yml$|^scripts/ci-scope\.mjs$`,
  String.raw`^scripts/testing/(?:host-e2e\.ts|duration-sequencer\.ts|vitest-shard-weights\.json|ci-retry-[^/]+)$|^server/testing/host-timeout\.ts$`,
  String.raw`^scripts/(?:build|bundle|prepare|package|smoke|after-pack|stage)[^/]*$`,
].join("|"), "i");

/** A changed line of code that names Windows or one of its APIs. */
export const WINDOWS_TEXT = new RegExp([
  String.raw`\bwin32\b|\bWindows\b|\bwindows-latest\b|[Pp]ower[Ss]hell|\bpwsh\b|\bcmd\.exe\b|\.exe\b|\bpath\.win32\b`,
  String.raw`\b(?:USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT|ComSpec)\b|\bwindows(?:Hide|VerbatimArguments)\b`,
].join("|"));

/** Why a pull request runs the Windows jobs, or null when nothing in it is Windows-sensitive: its label, a path above,
 * an e2e file the Windows shards also run (`hostE2e`), or a changed line in `lines` (`git diff -U0` of its code). */
export function windowsReason({ files, labels = [], hostE2e = [], lines = () => [] }) {
  if (labels.includes(WINDOWS_LABEL)) return `the "${WINDOWS_LABEL}" label`;
  const file = files.find((path) => WINDOWS_PATH.test(path) || hostE2e.includes(path));
  if (file) return file;
  let changed;
  try {
    changed = lines();
  } catch (error) {
    return `a change whose lines could not be read (${error.message})`;
  }
  const line = changed.find((text) => /^[+-](?![+-]{2} )/.test(text) && WINDOWS_TEXT.test(text));
  return line ? `the changed line ${JSON.stringify(line.slice(0, 80))}` : null;
}

/** True when two package.json texts differ only in the top-level "version"
 * (the release bump, prepare-release.yml). Anything else that changed, a
 * reordered key included, or text that is not a JSON object, is false. */
export function versionOnlyPackageJson(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(a) || !isObject(b)) return false;
  if (typeof a.version !== "string" || typeof b.version !== "string" || a.version === b.version) return false;
  const { version: _before, ...restBefore } = a;
  const { version: _after, ...restAfter } = b;
  return JSON.stringify(restBefore) === JSON.stringify(restAfter);
}

export const ALL_OS = ["macos-latest"];
export const LINUX_OS = ["ubuntu-latest"];
export const WINDOWS_OS = ["ubuntu-latest", "windows-latest"];
export const PLATFORM_POLICY = { version: 2, fullTestPlatforms: ["macos-latest"], retiredTestPlatforms: ["linux", "win32"] };

/** Events whose runs use the full macOS test selection. */
export const FULL_LANE_EVENTS = ["schedule", "workflow_dispatch"];

/** Which lane an event's run is: a pull request's own areas, main's, or full validation. */
export function laneOf(event) {
  if (event === "pull_request") return "pr";
  if (event === "push" || event === "merge_group") return "main";
  return "full";
}

export const VITEST_SHARDS = { "macos-latest": 10, "ubuntu-latest": 8, "windows-latest": 8 };

// Test files at once on each platform's runner (OMB_VITEST_WORKERS, vite.config.ts). A Linux shard mostly waits on real
// servers and fake engines: its 4 vCPU sat 70% idle one file at a time, and four files take a third of the time. A
// Windows shard one file at a time took 9 to 14 minutes (Nov 10 2026) and set the length of every run that has one;
// its runner has 4 vCPU too, so it runs two files at once.
export const VITEST_WORKERS = { "macos-latest": 1, "ubuntu-latest": 4, "windows-latest": 2 };

/** ci.yml's vitest matrix: every shard of every selected platform, and which e2e files that platform runs. */
export function vitestMatrix(oses) {
  return {
    include: oses.flatMap((os) => Array.from({ length: VITEST_SHARDS[os] }, (_, i) => ({
      os, part: `${os === "macos-latest" ? "all " : ""}shard ${i + 1}/${VITEST_SHARDS[os]}`, shard: i + 1,
      shards: VITEST_SHARDS[os], files: "",
      e2e: os === "windows-latest" ? "host" : "all", node_tests: i === 0, workers: VITEST_WORKERS[os],
    }))),
  };
}

/** What ci.yml runs for a scope on an event whose suite covers `oses`: the
 * selected job ids and the vitest matrix. */
export function ciOutputs({ checks, files }, oses) {
  if (!Array.isArray(oses) || oses.includes("windows-latest")
    || oses.includes("ubuntu-latest") && checks.includes("host-tests")) throw new Error("Retired full test platform");
  const platforms = oses.filter((os) => checks.includes(os === "ubuntu-latest" ? "linux-tests" : "host-tests"));
  const fullMac = oses.length === 1 && oses[0] === "macos-latest" && checks.includes("host-tests");
  const { include } = vitestMatrix(platforms);
  if (checks.includes("core-tests") && !platforms.includes("ubuntu-latest")) {
    if (!Array.isArray(files) || !files.length || files.some((file) => !SAFE_TEST_PATH.test(file))) throw new Error("Invalid core test selection");
    include.push({ os: "ubuntu-latest", part: "core + affected", shard: 1, shards: 1, files: files.join(" "), e2e: "all", node_tests: false, workers: 4 });
  }
  for (const [check, { part, files, shards, nodeTests }] of Object.entries(VITEST_SUBSETS)) {
    if (platforms.includes("ubuntu-latest") || fullMac || !checks.includes(check)) continue;
    for (let shard = 1; shard <= shards; shard++) {
      include.push({
        os: "ubuntu-latest", part: shards > 1 ? `${part} ${shard}/${shards}` : part, shard, shards,
        files: files.join(" "), e2e: "all", node_tests: nodeTests && shard === 1, workers: VITEST_WORKERS["ubuntu-latest"],
      });
    }
  }
  const jobs = SELECTABLE_JOBS.filter((job) => job === "vitest" ? include.length > 0 : checks.includes(job));
  return {
    jobs,
    build: checks.includes("build"),
    vitest_os: oses,
    packaged_server_os: [],
    // GitHub refuses an empty matrix, so a vitest job its `if` skips keeps the full one.
    vitest_matrix: include.length > 0 ? { include } : vitestMatrix(oses),
    ...(fullMac ? { platform_policy: PLATFORM_POLICY } : {}),
  };
}

const SHA = /^[a-f\d]{40}(?:[a-f\d]{24})?$/i;

const git = (args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

export function executedPullRequest(head, parents = () => git(["rev-list", "--parents", "-n", "1", "HEAD"])) {
  const commits = parents().trim().split(/\s+/);
  if (commits.length !== 3 || !commits.every((sha) => SHA.test(sha)) || commits[2] !== head) {
    throw new Error("PR checkout is not the event head merged onto a base commit");
  }
  return { merge: commits[0], base: commits[1], head };
}

export function changedFiles(range) {
  // Disabling rename detection retains both old and new paths, including deletions.
  const diff = git(["diff", "--name-only", "--no-renames", "-z", range, "--"]);
  if (!diff) return [];
  if (!diff.endsWith("\0")) throw new Error("Invalid changed-path output");
  return diff.slice(0, -1).split("\0");
}

/** The added and removed lines of a range's code, docs and translations left out. */
export function changedCodeLines(range) {
  return execFileSync("git", [
    "diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", range, "--", ".", ":(exclude)*.md", ":(exclude)docs/**", ":(exclude)src/locales/**",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).split("\n");
}

async function github(path) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = "https://api.github.com" } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are needed to read CI runs");
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${path.split("?")[0]}`);
  return response.json();
}

export async function pullRequestControls(pr, api = github) {
  const fromEvent = (Array.isArray(pr?.labels) ? pr.labels : []).map((label) => label?.name)
    .filter((name) => typeof name === "string").map((name) => name.toLowerCase());
  try {
    if (!Number.isSafeInteger(pr?.number)) throw new Error("Missing pull request number");
    const current = await api(`/issues/${pr.number}`);
    if (!Array.isArray(current.labels)) throw new Error("Missing current pull request labels");
    const labels = current.labels.map((label) => label.name.toLowerCase());
    const repairIds = labels.includes("qa:repair") ? [...String(current.body ?? "").matchAll(/^QA-Repair:\s*#(\d+)\s*$/gm)].map((hit) => Number(hit[1])) : [];
    return { labels, repairIds };
  } catch (error) {
    console.warn(`CI scope: requiring full validation because current PR controls are unavailable (${error.message})`);
    return { labels: [...new Set([...fromEvent, "ci:full"])], repairIds: [] };
  }
}

export async function runCiScope({ readPullRequest = pullRequestControls, fastPrEnabled = true, api = github } = {}) {
  const lane = laneOf(process.env.GITHUB_EVENT_NAME);
  let scope = lane === "main" ? MAIN_SCOPE : FULL_SCOPE;
  let vitestOs = ALL_OS;
  const mode = ["legacy", "shadow", "tiered"].includes(process.env.MAUSBOT_CI_MODE) ? process.env.MAUSBOT_CI_MODE : "legacy";
  const focusedPush = process.env.GITHUB_EVENT_NAME === "push";
  let plan, labels = [], repairIds = [], base, files, range, prNumber = null, prHead = null, execution = null, integration;
  if (lane === "pr") {
    try {
      const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      base = pr?.base?.sha;
      const head = pr?.head?.sha;
      prNumber = pr?.number ?? null;
      prHead = head ?? null;
      if (![base, head].every((sha) => typeof sha === "string" && SHA.test(sha))) {
        throw new Error("Missing or invalid pull request commit SHAs");
      }
      if (process.env.OMB_CI_EXECUTION_BINDING === "1") {
        execution = executedPullRequest(head);
        if (execution.merge !== process.env.GITHUB_SHA) throw new Error("PR checkout differs from the workflow merge revision");
        execution.tree = git(["rev-parse", "HEAD^{tree}"]).trim();
        base = execution.base;
      }
      range = execution ? `${base}..${execution.merge}` : `${base}...${head}`;
      files = changedFiles(range);
      if (!files.length && !execution) throw new Error("Empty pull request diff");
      ({ labels, repairIds } = await readPullRequest(pr));
      scope = selectCiScope(files);
      vitestOs = LINUX_OS;
    } catch (error) {
      if (process.env.OMB_CI_EXECUTION_BINDING === "1") throw error;
      console.warn(`CI scope: using all checks because the pull request diff is unavailable: ${error.message}`);
    }
  } else if (focusedPush) {
    const { before, after } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const checkout = git(["rev-parse", "HEAD"]).trim();
    if (after !== process.env.GITHUB_SHA || checkout !== after) throw new Error("Push checkout differs from the workflow revision");
    const history = git(["rev-list", "--first-parent", `--max-count=${MAIN_HISTORY_LIMIT}`, "HEAD"]).trim().split("\n");
    integration = integrationRange({ before, after, checkout, history, runs: (await api(MAIN_EVIDENCE_QUERY)).workflow_runs,
      repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID) });
    base = integration.base;
    range = `${base}..${after}`;
    files = changedFiles(range);
  }
  if (process.env.GITHUB_EVENT_NAME === "merge_group") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    base = event.merge_group?.base_sha;
    const head = event.merge_group?.head_sha;
    if (![base, head].every((sha) => SHA.test(sha ?? ""))) throw new Error("Invalid merge group revisions");
    range = `${base}...${head}`;
    files = changedFiles(range);
  }
  if (files) {
    const policy = readCheckPolicy(git(["show", `${base}:${POLICY_PATH}`]), (path) => existsSync(path) || path === "scripts/ci-linux-lanes.test.ts");
    const fastPr = fastPrEnabled && lane === "pr" && !labels.some((label) => ["ci:full", "qa:repair", WINDOWS_LABEL].includes(label));
    const input = { files, policy, labels, lines: changedCodeLines(range), mode, fastPr, focusedPush };
    plan = selectCheckPlan(input);
    if (mode === "tiered" && plan.candidate) {
      const { qaHealth } = await import("./qa/health.mjs");
      plan = selectCheckPlan({ ...input, qa: await qaHealth() });
    }
    if (plan.full) { scope = FULL_SCOPE; vitestOs = ALL_OS; }
    else if (lane === "pr" || focusedPush) {
      scope = plan.scope;
      vitestOs = scope.checks.includes("host-tests") ? ALL_OS : LINUX_OS;
    }
    else if (plan.reduced) {
      scope = plan.scope;
      vitestOs = LINUX_OS;
    }
  }
  const outputs = ciOutputs(scope, vitestOs);
  const { expectedJobs, MERGE_JOBS } = await import("./qa/contracts.mjs");
  const focused = plan?.fast || focusedPush;
  outputs.fast_pr = Boolean(plan?.fast);
  outputs.focused_push = focusedPush;
  outputs.settings_places = plan?.settingsPlaces ?? true;
  outputs.ci_verify = plan?.ciVerify ?? true;
  outputs.fast_files = focused ? plan.fastFiles.join(" ") : "";
  outputs.deferred_files = focused ? plan.deferred : [];
  outputs.deferred_checks = focused ? selectCiScope(files).checks.filter((check) => !scope.checks.includes(check)) : [];
  outputs.full_required = lane === "full" || scope === FULL_SCOPE || Boolean(plan?.full);
  outputs.required_jobs = outputs.jobs.filter((job) => MERGE_JOBS.includes(job));
  outputs.expected_jobs = expectedJobs(outputs, outputs.full_required);
  outputs.reduced = Boolean(plan?.reduced);
  outputs.qa_areas = plan?.holdAreas ?? ["global"];
  outputs.repair_ids = repairIds;
  outputs.comparison_base = base ?? "";
  outputs.pr_number = prNumber;
  outputs.pr_head = prHead;
  outputs.shadow = mode === "shadow" && plan?.candidate ? plan.core : [];
  const receipt = { version: 1, sha: process.env.GITHUB_SHA, runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
    createdAt: new Date().toISOString(), execution, ...(integration ? { integration } : {}), plan, outputs };
  writeFileSync("qa-plan.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(`CI scope: ${scope.areas.join(", ")} -> ${outputs.jobs.join(", ") || "static checks only"}`);
  if (integration) console.log(`CI scope: focused main integration ${integration.base}..${integration.head}, baseline ${integration.baselineRunId}:${integration.baselineAttempt}`);
  if (outputs.deferred_files.length) console.log(`CI scope: affected tests deferred to full QA: ${outputs.deferred_files.join(", ")}`);
  if (outputs.deferred_checks.length) console.log(`CI scope: other lanes or checks deferred to full QA: ${outputs.deferred_checks.join(", ")}`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${["fast_files", "comparison_base"].includes(key) ? value : typeof value === "boolean" ? value : JSON.stringify(value)}\n`).join(""),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCiScope().catch((error) => { console.error(error); process.exitCode = 1; });
}
