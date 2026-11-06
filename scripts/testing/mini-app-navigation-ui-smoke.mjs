import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";

const [dataDir, previewUrl, evidence] = process.argv.slice(2);
assert(dataDir && previewUrl && evidence);
const profile = join(dataDir, "mini-app-launcher-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const preload = join(profile, "synthetic-preload.cjs");
writeFileSync(preload, 'require("electron").contextBridge.exposeInMainWorld("ogb", { platform: process.platform, app: { version: "source-fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });');
const result = { source: "source Electron fixture with synthetic native marker", screenshots: [], geometry: [], checks: [], errors: [] };
const windows = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  try { return await Promise.race([promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const evaluate = (window, expression) => bounded(window.webContents.executeJavaScript(expression), `renderer evaluate: ${expression.slice(0, 70)}`);
async function until(probe, good, label, timeoutMs = 45_000) {
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
const open = async (window, query, expected = 5) => {
  await bounded(window.loadURL(previewUrl + query), `window load ${query}`, 45_000);
  await until(() => evaluate(window, 'document.querySelectorAll("[data-testid=mini-apps-panel] [role=tab]").length'),
    (count) => count === expected, `${expected} persisted app tabs`);
};
async function resizePanel(window, width) {
  const widthNow = () => evaluate(window, 'document.querySelector("[data-computer-panel]")?.getBoundingClientRect().width');
  await until(widthNow, (value) => Math.abs(value - 960) <= 1, "default measured 960px panel");
  await until(() => evaluate(window, 'Number(document.querySelector("[role=separator][aria-orientation=vertical]")?.getAttribute("aria-valuenow"))'),
    (value) => Math.abs(value - 960) <= 1, "resize signal ready");
  for (let expected = 920; expected >= width; expected -= 40) {
    await evaluate(window, `(() => { const separator = document.querySelector('[role=separator][aria-orientation=vertical]');
      separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true })); return true; })()`);
    await until(widthNow, (value) => Math.abs(value - expected) <= 1, `${expected}px measured panel`);
    await until(() => evaluate(window, 'Number(document.querySelector("[role=separator][aria-orientation=vertical]")?.getAttribute("aria-valuenow"))'),
      (value) => Math.abs(value - expected) <= 1, `${expected}px resize signal`);
  }
  return widthNow();
}
async function geometry(window, expected, name) {
  const measured = await evaluate(window, `(() => { const host=document.querySelector('[data-testid=mini-apps-panel]');
    const panel=document.querySelector('[data-computer-panel]').getBoundingClientRect();
    const row=host.querySelector('[role=tablist]').getBoundingClientRect();
    const all=host.querySelector('[data-mini-app-all]').getBoundingClientRect();
    const tiles=[...host.querySelectorAll('[role=tab]')].map(tab => {
      const icon=tab.querySelector('[data-mini-app-icon]').getBoundingClientRect();
      const label=tab.querySelector('span:last-child').getBoundingClientRect();
      const rect=tab.getBoundingClientRect(); return { left:rect.left, right:rect.right, top:rect.top, iconBottom:icon.bottom, labelTop:label.top }; });
    return { panelWidth:panel.width, rowLeft:row.left, rowRight:row.right, allLeft:all.left, allRight:all.right,
      hostRight:host.getBoundingClientRect().right, headerOverflow:host.querySelector('header').scrollWidth-host.querySelector('header').clientWidth, tiles }; })()`);
  assert(Math.abs(measured.panelWidth - expected) <= 1, `${name}: actual panel width ${measured.panelWidth}`);
  assert(measured.tiles.length === 5 && measured.tiles.every((tile) => Math.abs(tile.top - measured.tiles[0].top) <= 1
    && tile.iconBottom <= tile.labelTop + 1), `${name}: one launcher row with labels below icons`);
  assert(measured.rowRight <= measured.allLeft + 1 && measured.allRight <= measured.hostRight + 1, `${name}: fixed All apps stays visible`);
  assert(measured.headerOverflow <= 1, `${name}: no header overflow`);
  result.geometry.push({ name, expected, ...measured });
}
async function capture(window, name, full = false) {
  await evaluate(window, '(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
  const rect = full ? undefined : await evaluate(window, `(() => { const box=document.querySelector('[data-testid=mini-apps-panel]').getBoundingClientRect();
    return { x:Math.floor(box.x), y:Math.floor(box.y), width:Math.ceil(box.width), height:Math.ceil(box.height) }; })()`);
  writeFileSync(join(evidence, name), (await window.webContents.capturePage(rect)).toPNG());
  result.screenshots.push(name);
}
const click = (window, selector) => evaluate(window, `(() => { const node=document.querySelector(${JSON.stringify(selector)});
  if (!node || node.disabled) throw Error('Unavailable control: ' + ${JSON.stringify(selector)}); node.click(); return true; })()`);
const inventory = (window) => evaluate(window, '(async () => (await (await fetch("/api/mini-apps")).json()).apps)()');

async function metadataInteractions(window) {
  window.setContentSize(360, 780);
  await open(window, "?locale=en&skin=midnight");
  const installed = await evaluate(window, `(async () => {
    const app = (await (await fetch('/api/mini-apps')).json()).apps.find(entry => entry.shippedTemplateKind === 'bookkeeping');
    const response = await fetch('/api/mini-apps/' + app.id + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestKey: crypto.randomUUID(), expectedRevision: app.revision, slug: app.slug, title: app.title,
        description: 'Synthetic Mini App metadata', bindings: [], publisherBotIds: [],
        html: '<main style="padding:20px"><label>Note <input id="fixture-note"></label></main>' }) });
    if (!response.ok) throw Error(await response.text());
    return { previousVersion: app.templateVersion, ...(await response.json()).app };
  })()`);
  assert.deepEqual(installed.publisherBotIds, []);
  await open(window, "?locale=en&skin=midnight");
  await click(window, `[data-testid=mini-apps-panel] [role=tab][data-app-id="${installed.id}"]`);
  await until(() => evaluate(window, `(() => {
    const frame = document.querySelector('[data-testid=mini-apps-panel] iframe');
    return frame?.srcdoc.includes('fixture-note') && frame.sandbox.contains('allow-scripts')
      && !frame.sandbox.contains('allow-same-origin');
  })()`), Boolean, "real opaque Mini App iframe", 10_000);
  const history = '[data-testid=mini-apps-panel] > header details';
  await click(window, `${history} > summary`);
  const menu = await evaluate(window, `(() => {
    const header = document.querySelector('[data-testid=mini-apps-panel] > header');
    const details = header.querySelector('details');
    const box = details.querySelector('div').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      open: details.open, publisherChat: header.innerText.includes('Open publisher chat') };
  })()`);
  assert(menu.open && !menu.publisherChat && menu.width === 360 && menu.left >= 0 && menu.right <= menu.width
    && menu.top >= 0 && menu.bottom <= menu.height, JSON.stringify(menu));
  result.geometry.push({ name: "metadata-history-360-midnight-en.png", ...menu });
  await capture(window, "metadata-history-360-midnight-en.png", true);
  await click(window, `${history} > summary`);
  await evaluate(window, `(() => {
    const button = document.querySelector('[data-testid=mini-apps-panel] [role=tablist] [data-info-hint]');
    button.focus(); button.click();
    window.metadataFrameBlur = false;
    window.addEventListener('blur', () => { window.metadataFrameBlur = true; }, { once: true });
    return true;
  })()`);
  await until(() => evaluate(window, '!!document.querySelector("[data-info-hint-content]")'), Boolean, "pinned app metadata");
  await evaluate(window, `document.querySelector('[data-testid=mini-apps-panel] iframe').contentWindow.focus(); true`);
  await until(() => evaluate(window, `document.activeElement === document.querySelector('[data-testid=mini-apps-panel] iframe')
    && window.metadataFrameBlur && !document.querySelector('[data-info-hint-content]')`), Boolean, "frame focus dismisses pinned metadata", 5_000);
  result.checks.push("Pinned metadata closes when actual focus enters the opaque Mini App iframe");
  await click(window, `${history} > summary`);
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('${history} button')].find(node => node.textContent.startsWith('Version ${installed.previousVersion} ·'));
    if (!button || button.disabled) throw Error('Previous version unavailable');
    button.click(); return true;
  })()`);
  await until(() => inventory(window), apps => apps.some(app => app.id === installed.id
    && app.templateVersion === installed.previousVersion && app.revision === installed.revision + 1), "history rollback preserves selected version");
  result.checks.push("History without a publisher chat stays inside a 360px viewport and rolls back the selected version");
}

const timeout = setTimeout(() => { result.errors.push("Launcher fixture timed out");
  writeFileSync(join(evidence, "launcher-result.json"), JSON.stringify(result, null, 2) + "\n");
  app.exit(1); }, 170_000);
async function run() {
try {
  await bounded(app.whenReady(), "Electron ready", 30_000);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = makeWindow();
  if (process.argv.includes("--metadata-only")) {
    await metadataInteractions(window);
    return;
  }
  const vectors = [
    { width: 960, locale: "en", skin: "atelier", name: "launcher-960-atelier-en.png" },
    { width: 400, locale: "en", skin: "midnight", name: "launcher-400-midnight-en.png" },
    { width: 360, locale: "zh", skin: "atelier", name: "launcher-360-atelier-zh.png" },
  ];
  for (const vector of vectors) {
    await open(window, `?locale=${vector.locale}&skin=${vector.skin}`);
    await resizePanel(window, vector.width);
    await geometry(window, vector.width, vector.name);
    assert.equal(await evaluate(window, 'document.body.innerText.includes("Current app version") || document.body.innerText.includes("0 installed")'), false);
    await capture(window, vector.name);
    assert.equal(await evaluate(window, `(() => {
      const header = document.querySelector('[data-testid=mini-apps-panel] > header');
      const button = header.querySelector('[role=tablist] [data-info-hint]');
      return !!button && !button.closest('[role=tab]') && !/App updated|应用更新于/.test(header.innerText);
    })()`), true);
    await click(window, '[data-testid=mini-apps-panel] [role=tablist] [data-info-hint]');
    await until(() => evaluate(window, 'document.querySelector("[data-info-hint-content]")?.textContent'), Boolean, "app metadata disclosure");
    const info = await evaluate(window, `(() => {
      const hint = document.querySelector('[data-info-hint-content]'); const box = hint.getBoundingClientRect();
      return { text: hint.innerText, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
    })()`);
    assert(info.text.length > 10 && info.left >= 0 && info.right <= info.width && info.top >= 0 && info.bottom <= info.height);
    await capture(window, vector.name.replace('.png', '-info.png'), true);
    await evaluate(window, 'window.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", cancelable:true }))');
    await until(() => evaluate(window, 'document.querySelector("[data-info-hint-content]") === null'), Boolean, "metadata dismisses with Escape");
  }
  result.checks.push("App metadata stays collapsed beside the selected name and opens within the viewport");
  const before = await inventory(window);
  assert.equal(before.length, 5);
  const team = before.find((entry) => entry.dashboardIdentity === "agent-team");
  assert(team?.dashboard?.kind === "agent-team");
  assert(before.some((entry) => entry.dashboardIdentity === "usage" && entry.title === "Work Tracker"));
  await evaluate(window, `(() => { const host=document.querySelector('[data-testid=mini-apps-panel]');
    const tabs=[...host.querySelectorAll('[role=tab]')]; tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true})); return true; })()`);
  await until(() => evaluate(window, `(() => { const tabs=[...document.querySelectorAll('[data-testid=mini-apps-panel] [role=tab]')];
    return tabs.at(-1)?.getAttribute('aria-selected') === 'true'; })()`), Boolean, "last launcher tab selected");
  assert.equal(await evaluate(window, `(() => { const host=document.querySelector('[data-testid=mini-apps-panel]');
    const row=host.querySelector('[role=tablist]').getBoundingClientRect(); const tab=host.querySelector('[role=tab][aria-selected=true]').getBoundingClientRect();
    return tab.left >= row.left-1 && tab.right <= row.right+1; })()`), true);
  await click(window, '[data-mini-app-all]');
  await until(() => evaluate(window, 'document.querySelectorAll("[data-mini-app-popover] [data-mini-app-catalog]").length'), (count) => count === 5, "anchored app grid");
  const menu = await evaluate(window, `(() => { const pop=document.querySelector('[data-mini-app-popover]');
    const trigger=document.querySelector('[data-mini-app-all]');
    return {modal:pop.getAttribute('aria-modal'),anchored:trigger.parentElement.contains(pop),
      rightGap:Math.abs(pop.getBoundingClientRect().right-trigger.getBoundingClientRect().right)}; })()`);
  assert(menu.modal === "false" && menu.anchored && menu.rightGap <= 1);
  await capture(window, "launcher-grid-360-atelier-zh.png", true);
  await click(window, '[data-mini-app-remove="agent-team"]');
  await until(() => inventory(window), (apps) => apps.find((entry) => entry.id === team.id)?.status === "archived", "explicit app removal");
  assert.equal(await evaluate(window, 'document.querySelectorAll("[data-testid=mini-apps-panel] [role=tab]").length'), 4);
  await capture(window, "launcher-removed-360-atelier-zh.png");
  await open(window, "?locale=zh&skin=atelier", 4);
  await until(() => inventory(window), (apps) => apps.find((entry) => entry.id === team.id)?.status === "archived", "removed app stays removed on reopen");
  assert.equal(await evaluate(window, 'document.querySelectorAll("[data-testid=mini-apps-panel] [role=tab]").length'), 4);
  await click(window, '[data-mini-app-all]');
  await click(window, '[data-mini-app-grid-item="agent-team"]');
  await until(() => inventory(window), (apps) => apps.find((entry) => entry.id === team.id && entry.status === "active" && entry.dashboard?.kind === "agent-team"), "explicit same-id re-add");
  const restored = (await inventory(window)).find((entry) => entry.id === team.id);
  assert(restored.id === team.id && restored.revision > team.revision);
  await capture(window, "launcher-restored-960-atelier-zh.png");
  result.checks.push("Five owner-persisted defaults, one-row launcher, anchored grid, remove persistence and same-id Add");
  await open(window, "?shell=1&locale=en&skin=atelier");
  await resizePanel(window, 960);
  await until(() => evaluate(window, 'document.querySelector("textarea") !== null'), Boolean, "real chat composer");
  const shell = await evaluate(window, `(() => { const panel=document.querySelector('[data-computer-panel]').getBoundingClientRect();
    const composer=document.querySelector('textarea').getBoundingClientRect();
    const models=[...document.querySelectorAll('button')].filter(node => node.textContent.includes('Synthetic model')).map(node => node.getBoundingClientRect().right);
    return { panelLeft:panel.left, panelWidth:panel.width, composerRight:composer.right, modelCount:models.length,
      modelRight:Math.max(...models) }; })()`);
  assert(shell.modelCount > 0 && shell.composerRight <= shell.panelLeft+1 && shell.modelRight <= shell.panelLeft+1);
  result.geometry.push({ name: "launcher-full-shell-1800x1100-atelier-en.png", ...shell });
  await capture(window, "launcher-full-shell-1800x1100-atelier-en.png", true);
  const denied = makeWindow(false);
  await open(denied, "?locale=en&skin=midnight");
  await click(denied, '[data-mini-app-all]');
  await until(() => evaluate(denied, 'document.querySelector("[data-mini-app-popover]") !== null'), Boolean, "unsupported host grid");
  assert.equal(await evaluate(denied, '[...document.querySelectorAll("[data-mini-app-popover] [data-mini-app-grid-item]")].every(button => button.disabled)'), true);
  result.checks.push("Real chat shell stays clear; unsupported host cannot add or open default apps");
  await metadataInteractions(window);
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  clearTimeout(timeout);
  writeFileSync(join(evidence, "launcher-result.json"), JSON.stringify(result, null, 2) + "\n");
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  if (result.errors.length) { console.error(result.errors.join("\n")); app.exit(1); }
  else { console.log(JSON.stringify({ checks: result.checks, screenshots: result.screenshots })); app.quit(); }
}
}
void run();
