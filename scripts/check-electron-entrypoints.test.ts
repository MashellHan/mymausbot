import { expect, it } from "vitest";
import { checkElectronEntrypoints, electronReadyAwaits } from "./check-electron-entrypoints.mjs";

it("rejects Electron readiness awaited during entry module evaluation", () => {
  for (const source of [
    'import { app } from "electron"; await app.whenReady();',
    'import { app as desktop } from "electron"; await desktop.whenReady();',
    'import { app } from "electron"; await Promise.all([app.whenReady()]);',
  ]) expect(electronReadyAwaits(source)).toHaveLength(1);
});

it("allows an invoked async entry and unrelated module awaits", () => {
  expect(electronReadyAwaits('import { app } from "electron"; async function run() { await app.whenReady(); } void run();')).toEqual([]);
  expect(electronReadyAwaits('import { app } from "electron"; await readFile("fixture"); app.whenReady().then(start);')).toEqual([]);
  expect(electronReadyAwaits('const text = "await app.whenReady()";')).toEqual([]);
});

it("keeps checked-in Electron entrypoints free of the readiness deadlock", () => {
  expect(checkElectronEntrypoints()).toEqual([]);
});
