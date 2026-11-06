import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkElectronEntrypoints, electronReadyAwaits } from "./check-electron-entrypoints.mjs";

it("rejects Electron readiness awaited during entry module evaluation", () => {
  for (const source of [
    'import { app } from "electron"; await app.whenReady();',
    'import { app as desktop } from "electron"; await desktop.whenReady();',
    'import { app } from "electron"; await Promise.all([app.whenReady()]);',
    'import electron from "electron"; await electron.app.whenReady();',
    'import * as desktop from "electron"; await Promise.all([desktop . app.whenReady()]);',
  ]) expect(electronReadyAwaits(source)).toHaveLength(1);
});

it("allows an invoked async entry and unrelated module awaits", () => {
  expect(electronReadyAwaits('import { app } from "electron"; async function run() { await app.whenReady(); } void run();')).toEqual([]);
  expect(electronReadyAwaits('import { app } from "electron"; await readFile("fixture"); app.whenReady().then(start);')).toEqual([]);
  expect(electronReadyAwaits('import desktop from "electron"; async function run() { await desktop.app.whenReady(); } void run();')).toEqual([]);
  expect(electronReadyAwaits('import * as desktop from "electron"; desktop.app.whenReady().then(start);')).toEqual([]);
  expect(electronReadyAwaits('import desktop from "another-module"; await desktop.app.whenReady();')).toEqual([]);
  expect(electronReadyAwaits('const text = "await app.whenReady()";')).toEqual([]);
});

it("checks nested JavaScript and MJS entrypoints while excluding test modules", () => {
  const root = mkdtempSync(join(tmpdir(), "mausbot-entrypoints-"));
  try {
    mkdirSync(join(root, "electron", "nested"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    const source = 'import electron from "electron"; await electron.app.whenReady();';
    writeFileSync(join(root, "electron", "nested", "main.js"), source);
    writeFileSync(join(root, "scripts", "fixture.mjs"), source);
    writeFileSync(join(root, "scripts", "fixture.test.js"), source);
    expect(checkElectronEntrypoints(root).map((error: string) => error.split(":")[0])).toEqual([
      join("electron", "nested", "main.js"), join("scripts", "fixture.mjs"),
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps checked-in Electron entrypoints free of the readiness deadlock", () => {
  expect(checkElectronEntrypoints()).toEqual([]);
});
