import { expect, it } from "vitest";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { GITHUB_ACTIVITY_APP_ID, GITHUB_ACTIVITY_URL, githubActivityHostEligible,
  githubWebUrlForSelection, parseGithubSelection, selectionFromGithubPath } from "./github-activity-host";

const selected: MiniAppSummary = {
  id: GITHUB_ACTIVITY_APP_ID,
  slug: "github-activity",
  title: "Github Rending",
  description: "",
  status: "active",
  revision: 6,
  templateVersion: 6,
  shippedTemplateKind: "github_activity",
  publisherBotIds: ["synthetic-publisher"],
  createdAt: 1,
  updatedAt: 1,
};
const document: MiniAppDocument = { app: selected, html: "<p>Synthetic saved report</p>", bindings: [], versions: [] };
const state: MiniAppState = { appId: GITHUB_ACTIVITY_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [] };
const eligible = (change: Partial<Parameters<typeof githubActivityHostEligible>[0]> = {}) => githubActivityHostEligible({
  selected, document, state, localOwner: true, nativeGuard: true, ...change,
});

it("keeps the web reading view on the existing current local GitHub Activity only", () => {
  expect(GITHUB_ACTIVITY_URL).toBe("https://mxhan.com/github/");
  expect(eligible()).toBe(true);
  expect(eligible({ localOwner: false })).toBe(false);
  expect(eligible({ nativeGuard: false })).toBe(false);
  expect(eligible({ selected: { ...selected, id: "copied" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, id: "copied" } } })).toBe(false);
  expect(eligible({ state: { ...state, appId: "copied" } })).toBe(false);
  expect(eligible({ selected: { ...selected, slug: "other-slug" } })).toBe(false);
  expect(eligible({ selected: { ...selected, shippedTemplateKind: "x_ai_digest" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, shippedTemplateKind: null } } })).toBe(false);
  expect(eligible({ selected: { ...selected, status: "archived" } })).toBe(false);
  expect(eligible({ state: { ...state, status: "archived" } })).toBe(false);
  expect(eligible({ selected: { ...selected, revision: 7 } })).toBe(false);
  expect(eligible({ state: { ...state, templateVersion: 7 } })).toBe(false);
  expect(eligible({ selected: { ...selected, nativeKind: "hongguo" } })).toBe(false);
});

it("validates and maps canonical edition/repo selections in both directions", () => {
  expect(parseGithubSelection({ editionKey: "2026-11-20", repo: "dream-num/univer" }))
    .toEqual({ editionKey: "2026-11-20", repo: "dream-num/univer" });
  expect(parseGithubSelection({ editionKey: null, repo: "dream-num/univer" })).toBeNull();
  expect(parseGithubSelection({ editionKey: "2026-11-20", repo: "Dream-Num/univer" })).toBeNull();
  expect(parseGithubSelection({ editionKey: "2026-11-20", repo: "../univer" })).toBeNull();

  expect(githubWebUrlForSelection(null)).toBe("https://mxhan.com/github/");
  expect(githubWebUrlForSelection({ editionKey: "2026-11-19", repo: "dream-num/univer" })).toBe("https://mxhan.com/github/");
  expect(githubWebUrlForSelection({ editionKey: "2026-11-20", repo: null })).toBe("https://mxhan.com/github/20261120/");
  expect(githubWebUrlForSelection({ editionKey: "2026-11-20", repo: "dream-num/univer" }))
    .toBe("https://mxhan.com/github/20261120/dream-num/univer/");

  expect(githubWebUrlForSelection({ editionKey: "2026-11-22", repo: "tobymao/sqlglot" }))
    .toBe("https://mxhan.com/github/20261122/tobymao/sqlglot/");

  expect(selectionFromGithubPath("/github/20261120/dream-num/univer/", "2026-11-20", "dream-num/univer"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-20", repo: "dream-num/univer" } });
  expect(selectionFromGithubPath("/github/20261120/dream-num/univer/", "2026-11-20", "other/repo"))
    .toEqual({ ok: false });
  expect(selectionFromGithubPath("/github/demo/univer-orders/"))
    .toEqual({ ok: true, selection: { editionKey: null, repo: null } });
  expect(selectionFromGithubPath("/github/demo/pandera-orders/", "2026-11-21", "unionai-oss/pandera"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-21", repo: "unionai-oss/pandera" } });
  expect(selectionFromGithubPath("/github/demo/pandera-orders/"))
    .toEqual({ ok: true, selection: { editionKey: null, repo: null } });
  expect(selectionFromGithubPath("/github/demo/pandera-orders/source.zip", "2026-11-21", "unionai-oss/pandera"))
    .toEqual({ ok: false });
  expect(selectionFromGithubPath("/github/demo/sqlglot-query-lab/", "2026-11-22", "tobymao/sqlglot"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-22", repo: "tobymao/sqlglot" } });
  expect(selectionFromGithubPath("/github/demo/sqlglot-query-lab/#sqlite-exec", "2026-11-22", "tobymao/sqlglot"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-22", repo: "tobymao/sqlglot" } });
  expect(selectionFromGithubPath("/github/demo/sqlglot-query-lab/", undefined, undefined, "leaving"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-22", repo: "tobymao/sqlglot" } });
  expect(selectionFromGithubPath("/github/demo/sqlglot-query-lab/", undefined, undefined, "shown"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-22", repo: "tobymao/sqlglot" } });
  expect(selectionFromGithubPath("/github/demo/sqlglot-query-lab/", "2026-11-22", "tobymao/sqlglot", "shown"))
    .toEqual({ ok: true, selection: { editionKey: "2026-11-22", repo: "tobymao/sqlglot" } });
  const rejectedSqlglotCases: ReadonlyArray<Parameters<typeof selectionFromGithubPath>> = [
    ["/github/demo/sqlglot-query-lab/"],
    ["/github/demo/sqlglot-query-lab/", null, null],
    ["/github/demo/sqlglot-query-lab/", "2026-11-22"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-22", null],
    ["/github/demo/sqlglot-query-lab/", null, "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-21", "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-22", "unionai-oss/pandera"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-21", "tobymao/sqlglot", "leaving"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-22", "other/repo", "shown"],
    ["/github/demo/sqlglot-query-lab/", "2026-11-22", undefined, "shown"],
    ["/github/demo/sqlglot-query-lab/", null, null, "leaving"],
    ["/github/demo/sqlglot-query-lab/sqlglot-query-lab-source.zip", "2026-11-22", "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab/results.json", "2026-11-22", "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab/run_demo.py", "2026-11-22", "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab/index.html", "2026-11-22", "tobymao/sqlglot"],
    ["/github/demo/sqlglot-query-lab", "2026-11-22", "tobymao/sqlglot"],
  ];
  for (const args of rejectedSqlglotCases) {
    expect(selectionFromGithubPath(...args)).toEqual({ ok: false });
  }
  expect(selectionFromGithubPath("/github/media/demo.png")).toEqual({ ok: false });
});
