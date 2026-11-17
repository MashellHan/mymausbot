import { expect, it } from "vitest";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { miniAppDisplayDescription, miniAppDisplayName } from "./mini-app-display";
import { setLocale, t } from "@/lib/i18n";

it("shows the stock Github Rending name while retaining a customized report title", () => {
  const old = { title: "GitHub activity", shippedTemplateKind: "github_activity" } as MiniAppSummary;
  expect(miniAppDisplayName(old)).toBe("Github Rending");
  expect(miniAppDisplayName({ ...old, title: "GitHub activity & discovery" })).toBe("Github Rending");
  expect(miniAppDisplayName({ ...old, title: "My open-source notes" })).toBe("My open-source notes");
});

it("shows 红果 for the installed native identity without changing stored names, grants or revisions", () => {
  setLocale("en");
  const app = Object.freeze({ id: "retained-app", slug: "hongguo", title: "红果短剧", description: "Legacy default", revision: 4,
    nativeIdentity: "hongguo", nativeKind: null, status: "active" } as MiniAppSummary);
  expect(miniAppDisplayName(app)).toBe("红果");
  expect(miniAppDisplayDescription(app)).toBe("浏览短剧，并从本机保存的剧集进度继续观看。");
  expect(app).toMatchObject({ id: "retained-app", title: "红果短剧", revision: 4, nativeKind: null });
  expect(miniAppDisplayName({ ...app, nativeIdentity: null })).toBe("红果短剧");
  expect(t("engines.cloud")).toBe("Cloud");
});

it("keeps customized dashboard and ordinary report titles", () => {
  const custom = { title: "My work journal", dashboardIdentity: "usage" } as MiniAppSummary;
  expect(miniAppDisplayName(custom)).toBe("My work journal");
  expect(miniAppDisplayName({ ...custom, title: "Work Tracker", dashboardIdentity: null })).toBe("Work Tracker");
});
