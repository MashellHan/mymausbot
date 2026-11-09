import { expect, it } from "vitest";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { miniAppDisplayName } from "./mini-app-display";

it("shows the stock Github Rending name while retaining a customized report title", () => {
  const old = { title: "GitHub activity", shippedTemplateKind: "github_activity" } as MiniAppSummary;
  expect(miniAppDisplayName(old)).toBe("Github Rending");
  expect(miniAppDisplayName({ ...old, title: "GitHub activity & discovery" })).toBe("Github Rending");
  expect(miniAppDisplayName({ ...old, title: "My open-source notes" })).toBe("My open-source notes");
});

it("keeps customized dashboard and ordinary report titles", () => {
  const custom = { title: "My work journal", dashboardIdentity: "usage" } as MiniAppSummary;
  expect(miniAppDisplayName(custom)).toBe("My work journal");
  expect(miniAppDisplayName({ ...custom, title: "Work Tracker", dashboardIdentity: null })).toBe("Work Tracker");
});
