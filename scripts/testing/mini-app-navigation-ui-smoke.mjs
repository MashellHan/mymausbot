import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";

const [mode, dataDir, previewUrl, evidence] = process.argv.slice(2);
assert(["empty", "installed"].includes(mode) && dataDir && previewUrl && evidence);
const profile = join(dataDir, `mini-app-nav-${mode}-profile`);
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const preload = join(profile, "synthetic-preload.cjs");
writeFileSync(preload, 'require("electron").contextBridge.exposeInMainWorld("ogb", { platform: process.platform, app: { version: "source-fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });');
const result = { mode, source: "source Electron fixture with synthetic native marker", screenshots: [], geometry: [], checks: [], errors: [] };
const windows = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  try { return await Promise.race([promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const evaluate = (window, expression) => bounded(window.webContents.executeJavaScript(expression), `renderer evaluate: ${expression.slice(0, 70)}`);
async function until(probe, good, label, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (good(value)) return value;
    if (Date.now() > end) throw new Error(`${label}: ${JSON.stringify(value)}`);
    await wait(100);
  }
}
function makeWindow(capability = true) {
  const window = new BrowserWindow({ show: false, width: 1800, height: 1100, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    ...(capability ? { preload } : {}),
  } });
  windows.push(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}
const open = async (window, query) => {
  console.log(`opening ${mode} ${query}`);
  await bounded(window.loadURL(previewUrl + query), `window load ${query}`, 45_000);
  await until(() => evaluate(window, 'document.querySelector("[data-testid=mini-apps-panel]") !== null'), Boolean, "Mini Apps panel");
  await until(() => evaluate(window, 'document.querySelector("[data-mini-app-all]") !== null'), Boolean, "All apps control");
  console.log(`ready ${mode} ${query}`);
};
async function resizePanel(window, width) {
  const widthNow = () => evaluate(window, 'document.querySelector("[data-computer-panel]")?.getBoundingClientRect().width');
  await until(widthNow, (value) => Math.abs(value - 960) <= 1, "default measured 960px panel");
  await until(() => evaluate(window, 'Number(document.querySelector("[role=separator][aria-orientation=vertical]")?.getAttribute("aria-valuenow"))'),
    (value) => Math.abs(value - 960) <= 1, "resize signal ready");
  for (let expected = 920; expected >= width; expected -= 40) {
    await evaluate(window, `(() => { const separator = document.querySelector('[role=separator][aria-orientation=vertical]');
      separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); return true; })()`);
    await until(widthNow, (value) => Math.abs(value - expected) <= 1, `${expected}px measured panel`);
    await until(() => evaluate(window, 'Number(document.querySelector("[role=separator][aria-orientation=vertical]")?.getAttribute("aria-valuenow"))'),
      (value) => Math.abs(value - expected) <= 1, `${expected}px resize signal`);
  }
  return widthNow();
}
async function geometry(window, expected, name) {
  const measured = await evaluate(window, `(() => {
    const panel = document.querySelector('[data-computer-panel]');
    const host = document.querySelector('[data-testid=mini-apps-panel]');
    const row = host.querySelector('[data-mini-app-included-row], [role=tablist]');
    const all = host.querySelector('[data-mini-app-all]');
    const tabs = [...row.querySelectorAll(':scope > button')];
    const r = (node) => { const b = node.getBoundingClientRect(); return { left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width }; };
    return { panel:r(panel), host:r(host), row:r(row), all:r(all), items:tabs.map(r),
      hostOverflow:host.scrollWidth-host.clientWidth, headerOverflow:host.querySelector('header').scrollWidth-host.querySelector('header').clientWidth,
      installedTabs:host.querySelectorAll('[role=tab]').length, includedTiles:host.querySelectorAll('[data-mini-app-included]').length };
  })()`);
  assert(Math.abs(measured.panel.width - expected) <= 1, `${name}: actual panel width ${measured.panel.width}`);
  assert(measured.items.length === 5 && measured.items.every((item) => Math.abs(item.top - measured.items[0].top) <= 1), `${name}: one app row`);
  assert(measured.row.right <= measured.all.left + 1 && measured.all.right <= measured.host.right + 1, `${name}: fixed All apps stays visible`);
  assert(measured.headerOverflow <= 1, `${name}: no header overflow`);
  assert(mode === "empty" ? measured.includedTiles === 5 && measured.installedTabs === 0
    : measured.installedTabs === 5 && measured.includedTiles === 0);
  result.geometry.push({ name, expected, ...measured });
}
async function capture(window, name, full = false) {
  await evaluate(window, '(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
  const rect = full ? undefined : await evaluate(window, `(() => { const box = document.querySelector('[data-testid=mini-apps-panel]').getBoundingClientRect();
    return { x:Math.floor(box.x), y:Math.floor(box.y), width:Math.ceil(box.width), height:Math.ceil(box.height) }; })()`);
  writeFileSync(join(evidence, name), (await window.webContents.capturePage(rect)).toPNG());
  result.screenshots.push(name);
}
async function click(window, selector) {
  return evaluate(window, `(() => { const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled) throw Error('Unavailable control: ' + ${JSON.stringify(selector)}); node.click(); return true; })()`);
}

const timeout = setTimeout(() => { result.errors.push("Navigation fixture timed out");
  writeFileSync(join(evidence, `${mode}-result.json`), JSON.stringify(result, null, 2) + "\n");
  console.error("Navigation fixture timed out"); app.exit(1); }, 170_000);
async function run() {
try {
  console.log(`starting ${mode} Electron fixture`);
  await bounded(app.whenReady(), "Electron ready", 30_000);
  console.log(`Electron ready for ${mode}`);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = makeWindow();
  const vectors = mode === "empty" ? [
    { width: 960, locale: "en", skin: "atelier", name: "empty-960-atelier-en.png" },
    { width: 400, locale: "en", skin: "midnight", name: "empty-400-midnight-en.png" },
    { width: 360, locale: "zh", skin: "atelier", name: "empty-360-atelier-zh.png" },
  ] : [
    { width: 960, locale: "en", skin: "midnight", name: "installed-960-midnight-en.png" },
    { width: 400, locale: "en", skin: "atelier", name: "installed-400-atelier-en.png" },
    { width: 360, locale: "zh", skin: "midnight", name: "installed-360-midnight-zh.png" },
  ];
  for (const vector of vectors) {
    await open(window, `?locale=${vector.locale}&skin=${vector.skin}`);
    await resizePanel(window, vector.width);
    await geometry(window, vector.width, vector.name);
    if (mode === "installed" && vector.width === 360) {
      await evaluate(window, `(() => { const tab = document.querySelector('[data-testid=mini-apps-panel] [role=tab][aria-selected=true]'); tab.focus();
        tab.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true, cancelable:true })); return true; })()`);
      await until(() => evaluate(window, `(() => { const tabs=[...document.querySelectorAll('[data-testid=mini-apps-panel] [role=tab]')];
        return tabs.at(-1)?.getAttribute('aria-selected') === 'true'; })()`), Boolean, "last app selected after End");
      const visible = await evaluate(window, `(() => { const host=document.querySelector('[data-testid=mini-apps-panel]');
        const row=host.querySelector('[role=tablist]').getBoundingClientRect();
        const selected=host.querySelector('[role=tab][aria-selected=true]').getBoundingClientRect();
        return selected.left >= row.left-1 && selected.right <= row.right+1; })()`);
      assert.equal(visible, true, "selected tab fully visible after keyboard navigation");
    }
    await capture(window, vector.name);
  }
  result.checks.push("Measured 960/400/360px panel bounds and one-row navigation across EN/ZH and light/dark");

  if (mode === "empty") {
    assert.deepEqual(await evaluate(window, '(async () => (await (await fetch("/api/mini-apps")).json()).apps)()'), []);
    await click(window, '[data-mini-app-included="agent-team"]');
    await until(() => evaluate(window, 'document.activeElement?.dataset.miniAppCatalog'), (value) => value === "agent-team", "tile focuses library entry");
    const statuses = await evaluate(window, `Object.fromEntries([...document.querySelectorAll('[data-mini-app-catalog]')].map(node => [node.dataset.miniAppCatalog,node.dataset.miniAppState]))`);
    assert.equal(statuses.bookkeeping, "data");
    assert.equal(statuses.x_ai_digest, "ready");
    await capture(window, "empty-library-360-atelier-zh.png", true);
    await click(window, '[data-mini-app-choice="agent-team"]');
    await until(() => evaluate(window, 'document.querySelector("[data-testid=dashboard-install]") !== null'), Boolean, "dashboard disclosure");
    assert(await evaluate(window, 'document.querySelector("[data-testid=dashboard-install]").innerText.includes("Herdr")'));
    await until(() => evaluate(window, '[...document.querySelectorAll("[data-testid=dashboard-install] button")].some(button => button.textContent.includes("安装应用") && !button.disabled)'), Boolean, "owner install enabled");
    await evaluate(window, `([...document.querySelectorAll('[data-testid=dashboard-install] button')].find(button => button.textContent.includes('安装应用'))).click()`);
    const installed = await until(() => evaluate(window, '(async () => (await (await fetch("/api/mini-apps")).json()).apps.find(app => app.dashboardIdentity === "agent-team"))()'),
      (app) => app?.status === "active" && app.dashboard?.kind === "agent-team", "explicit Team owner install");
    assert.equal(installed.revision, 1);
    result.checks.push("Empty registry stayed truthful; included tile opened focused library and explicit Team owner publication");
    const denied = makeWindow(false);
    await open(denied, "?locale=en&skin=midnight");
    await click(denied, '[data-mini-app-all]');
    await until(() => evaluate(denied, 'document.querySelector("#mini-app-library-dialog") !== null'), Boolean, "unsupported host library");
    assert.equal(await evaluate(denied, 'document.querySelectorAll("#mini-app-library-dialog [data-mini-app-choice]").length'), 0);
    result.checks.push("Unsupported host shows catalog without owner install actions");
  } else {
    const kinds = await evaluate(window, `[...document.querySelectorAll('[data-testid=mini-apps-panel] [role=tab] [data-mini-app-icon]')].map(node => node.dataset.miniAppIcon).sort()`);
    assert.deepEqual(kinds, ["agent-team", "bookkeeping", "github_activity", "usage", "x_ai_digest"].sort());
    await click(window, '[data-mini-app-all]');
    await until(() => evaluate(window, 'document.querySelector("#mini-app-library-dialog") !== null'), Boolean, "installed library");
    assert.equal(await evaluate(window, 'document.querySelectorAll("#mini-app-library-dialog [data-mini-app-open]").length'), 5);
    assert.equal(await evaluate(window, `[...document.querySelectorAll('#mini-app-library-dialog [data-mini-app-catalog]')].filter(node => node.dataset.miniAppState === 'installed').length`), 5);
    await capture(window, "installed-library-360-midnight-zh.png", true);
    await evaluate(window, `document.querySelector('#mini-app-library-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await open(window, "?shell=1&locale=en&skin=atelier");
    await resizePanel(window, 960);
    await until(() => evaluate(window, 'document.querySelector("textarea") !== null'), Boolean, "real chat composer");
    const shell = await evaluate(window, `(() => { const panel=document.querySelector('[data-computer-panel]').getBoundingClientRect();
      const composer=document.querySelector('textarea').getBoundingClientRect();
      const controls=[...document.querySelectorAll('button')].filter(node => node.textContent.includes('Synthetic model')).map(node => node.getBoundingClientRect().right);
      return { panelLeft:panel.left, panelWidth:panel.width, composerRight:composer.right,
        modelCount:controls.length, modelRight:Math.max(...controls) }; })()`);
    assert(shell.modelCount > 0 && shell.composerRight <= shell.panelLeft+1 && shell.modelRight <= shell.panelLeft+1,
      "chat controls must not cover the Mini Apps panel");
    result.geometry.push({ name: "installed-full-shell-1800x1100-atelier-en.png", ...shell });
    await capture(window, "installed-full-shell-1800x1100-atelier-en.png", true);
    result.checks.push("Five provenance-marked apps and one usable full shell keep chat controls clear");
  }
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  clearTimeout(timeout);
  writeFileSync(join(evidence, `${mode}-result.json`), JSON.stringify(result, null, 2) + "\n");
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  if (result.errors.length) { console.error(result.errors.join("\n")); app.exit(1); }
  else { console.log(JSON.stringify({ mode, checks: result.checks, screenshots: result.screenshots })); app.quit(); }
}
}
void run();
