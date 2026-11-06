import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, powerSaveBlocker, session } from "electron";
import { appFrameBlinkSettings, appFrameNavigationAllowed } from "../../electron/app-frame-guard.mjs";

const [dataDir, previewUrl, evidence] = process.argv.slice(2);
assert(dataDir && previewUrl && evidence, "Run through scripts/verify-mini-apps.ts");
const profile = join(dataDir, "mini-app-ui-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const inheritedBlinkSettings = app.commandLine.getSwitchValue("blink-settings");
assert(inheritedBlinkSettings.includes("imagesEnabled=true"), "parent supplies an existing Blink setting");
app.commandLine.appendSwitch("blink-settings", appFrameBlinkSettings(inheritedBlinkSettings));
assert.equal(app.commandLine.getSwitchValue("blink-settings"), "imagesEnabled=true,dnsPrefetchingEnabled=false");
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.miniapp-canary.invalid ~NOTFOUND");
const netlog = join(profile, "netlog.json");
const preload = join(profile, "preload.cjs");
writeFileSync(preload, `require("electron").contextBridge.exposeInMainWorld("ogb", { platform: process.platform, app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });`);
const result = { checks: [], screenshots: [], geometry: [], errors: [] };
const passed = (label) => { result.checks.push(label); console.log(label); };
const windows = [];
const reads = new Map();
const blocked = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (window, js) => window.webContents.executeJavaScript(js);
const frame = (window) => window.webContents.mainFrame.frames.find((entry) => entry.url.startsWith("about:srcdoc"));
const inFrame = (window, js) => {
  const target = frame(window);
  if (!target) throw new Error("Mini App frame is unavailable");
  return target.executeJavaScript(js);
};
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function windowFor({ guarded = true, capability = true, width = 1400 } = {}) {
  const window = new BrowserWindow({ show: false, width, height: 980, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, ...(capability ? { preload } : {}),
  } });
  windows.push(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (guarded) window.webContents.on("will-frame-navigate", (details) => {
    if (!appFrameNavigationAllowed(details)) { blocked.push(details.url); details.preventDefault(); }
  });
  return window;
}
const open = (window, query) => window.loadURL(previewUrl + query);
const content = (window) => inFrame(window, 'document.body?.innerText ?? ""');
const ready = (window) => until(async () => frame(window) && await inFrame(window, '!!document.querySelector("#currency") && !document.querySelector("#refresh").disabled && document.querySelector("#notice").hidden && !!document.querySelector("#range-label").textContent'), "bookkeeping report ready");
const select = async (window, id, value) => {
  const before = reads.get(window.webContents.id) ?? 0;
  await inFrame(window, `(() => { const node = document.getElementById(${JSON.stringify(id)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await until(() => (reads.get(window.webContents.id) ?? 0) > before, `${id} changes the query`);
  await ready(window);
};
const hostClick = (window, label) => evaluate(window, `(() => {
  const node = [...document.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") || button.textContent.trim()) === ${JSON.stringify(label)});
  if (!node || node.disabled) throw new Error("Missing enabled control: " + ${JSON.stringify(label)});
  node.click(); return true;
})()`);
async function capture(window, name, fullWindow = false) {
  let previous = "";
  let stableSince = Date.now();
  await until(async () => {
    if (frame(window)) await ready(window);
    const snapshot = 'JSON.stringify([document.body.innerText, Array.from(document.querySelectorAll("select,input"), node => node.value), scrollX, scrollY])';
    const current = await evaluate(window, snapshot) + (frame(window) ? await inFrame(window, snapshot) : "");
    if (current !== previous) { previous = current; stableSince = Date.now(); }
    return Date.now() - stableSince >= 300;
  }, `stable capture: ${name}`);
  const painted = '(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()';
  if (frame(window)) await inFrame(window, painted);
  await evaluate(window, painted);
  const rect = fullWindow ? undefined : await evaluate(window, `(() => { const node = document.querySelector('[data-testid="mini-apps-panel"]'); const r=node.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`);
  writeFileSync(join(evidence, name), (await window.webContents.capturePage(rect)).toPNG());
  result.screenshots.push(name);
}
async function noOverflow(window) {
  assert.equal(await inFrame(window, 'document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'), true, "app must fit its panel");
  assert.equal(await evaluate(window, 'document.documentElement.scrollWidth <= innerWidth + 1'), true, "host must fit its window");
  const gaps = await inFrame(window, `Array.from(document.querySelectorAll(".trend-row"), row => {
    const range = document.createRange(); range.selectNodeContents(row.querySelector(".trend-label"));
    return row.querySelector(".trend-track").getBoundingClientRect().left - range.getBoundingClientRect().right;
  })`);
  assert(gaps.every((gap) => gap >= 6), "full trend dates must have a visible gap before their bars");
}
async function resizePanel(window, width) {
  const actual = () => evaluate(window, 'document.querySelector("[data-computer-panel]")?.getBoundingClientRect().width');
  await until(async () => Math.abs((await actual()) - 960) <= 1, "default 960px panel");
  for (let expected = 920; expected >= width; expected -= 40) {
    await evaluate(window, `(() => { const separator = document.querySelector('[role="separator"][aria-orientation="vertical"]');
      separator.focus(); separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); return true; })()`);
    await until(async () => Math.abs((await actual()) - expected) <= 1, `${expected}px panel after separator key`);
  }
  assert(Math.abs((await actual()) - width) <= 1, `Measured panel width must be ${width}px`);
  return actual();
}
const timer = setTimeout(() => { result.errors.push("Mini App UI smoke timed out"); writeFileSync(join(evidence, "mini-apps-result.json"), JSON.stringify(result, null, 2)); app.exit(1); }, 220_000);
async function run() {
try {
  await app.whenReady();
  powerSaveBlocker.start("prevent-app-suspension");
  await session.defaultSession.netLog.startLogging(netlog);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/\/api\/mini-apps\/[^/]+\/query$/.test(details.url)) reads.set(details.webContentsId, (reads.get(details.webContentsId) ?? 0) + 1);
    callback({});
  });

  const browser = windowFor({ capability: false });
  await open(browser, "?locale=en");
  await until(() => evaluate(browser, 'document.body.innerText.includes("desktop")'), "unsupported host message");
  assert.equal(await evaluate(browser, 'document.querySelectorAll("iframe").length'), 0);
  assert.equal(reads.get(browser.webContents.id) ?? 0, 0);
  passed("Browser host without native guard cannot mount or query Mini Apps");
  browser.destroy();

  for (const vector of ["link", "assign", "replace", "meta", "resources"]) {
    const probe = windowFor();
    await open(probe, `?probe=${vector}`);
    await until(async () => frame(probe) && await inFrame(probe, 'window.probeReady === true'), `guarded ${vector} probe`);
    await pause(650);
    assert.deepEqual(await fetch(new URL("/__mini-app-sink", previewUrl)).then((res) => res.json()), { hits: [], connections: 0 });
    assert((await content(probe)).includes("-15.54"), "probe read actual synthetic Data before its exit attempts");
    probe.destroy();
  }
  assert(blocked.length >= 4, "native guard observed all four self-navigation attempts");
  await pause(1500);
  await session.defaultSession.netLog.stopLogging();
  const guardedNetwork = JSON.parse(readFileSync(netlog, "utf8"));
  writeFileSync(join(evidence, "mini-app-network.json"), JSON.stringify(guardedNetwork));
  const resolverTypes = new Set(Object.entries(guardedNetwork.constants.logEventTypes).filter(([name]) => /HOST_RESOLVER|DNS_/.test(name)).map(([, id]) => id));
  const guardedResolutions = guardedNetwork.events.filter((event) => resolverTypes.has(event.type)).map((event) => JSON.stringify(event));
  assert(!guardedResolutions.some((event) => event.includes("~notfound")), "Mini App DNS hint must not reach the resolver");
  await session.defaultSession.netLog.startLogging(netlog);
  const control = windowFor({ guarded: false });
  await open(control, "?probe=assign");
  await until(async () => (await fetch(new URL("/__mini-app-sink", previewUrl)).then((res) => res.json())).hits.length > 0, "unguarded negative control reaches sink");
  await evaluate(control, 'fetch("http://control.miniapp-canary.invalid/").catch(() => null)');
  control.destroy();
  await session.defaultSession.netLog.stopLogging();
  const network = JSON.parse(readFileSync(netlog, "utf8"));
  writeFileSync(join(evidence, "mini-app-network-control.json"), JSON.stringify(network));
  const resolutionEvents = network.events.filter((event) => resolverTypes.has(event.type)).map((event) => JSON.stringify(event));
  assert(resolutionEvents.some((event) => event.includes("~notfound")), "DNS negative control must appear in NetLog");
  passed("Production guard blocks link, assign, replace and meta refresh after a real named query; unguarded control reaches sink");
  passed("CSP blocks fetch, beacon, resources, nested frames and form submission");
  passed("Disabled DNS speculation blocks the frame canary; normal DNS resolution remains visible in the control");

  const window = windowFor();
  for (const { width, locale, skin, name } of [
    { width: 960, locale: "en", skin: "midnight", name: "desktop.png" },
    { width: 960, locale: "zh", skin: "atelier", name: "desktop-light.png" },
    { width: 360, locale: "zh", skin: "midnight", name: "mobile.png" },
    { width: 400, locale: "en", skin: "atelier", name: "narrow-light.png" },
  ]) {
    await open(window, `?locale=${locale}&skin=${skin}`);
    result.geometry.push({ name, requested: width, measured: await resizePanel(window, width) });
    await ready(window);
    await select(window, "currency", "known:CNY");
    assert((await content(window)).includes("12.54"));
    await noOverflow(window);
    await inFrame(window, 'window.scrollTo(0,0); true');
    await capture(window, name);
    if (width === 960 && locale === "en") await capture(window, "desktop-context.png", true);
    if (width === 360) {
      await inFrame(window, 'document.getElementById("trend-title").scrollIntoView(); true');
      await capture(window, "mobile-details.png");
    }
  }
  passed("Real panel renders and fits 960, 400 and 360 pixel panels in light/dark and zh/en");
  await open(window, "?locale=en&skin=midnight");
  await ready(window);
  await select(window, "currency", "known:CNY");
  assert(await inFrame(window, 'Array.from(document.querySelector("#category").options).some(option => option.value === "Transfer")'), "inflow-only category is selectable");
  await select(window, "category", "Transfer");
  assert((await inFrame(window, 'document.getElementById("summary").innerText')).includes("25.00"));
  assert.equal(await inFrame(window, 'document.querySelectorAll(".entry").length'), 1);
  assert((await inFrame(window, 'document.getElementById("details").innerText')).includes("Inflow"));
  assert.equal(await inFrame(window, 'document.getElementById("categories").innerText'), "No spending categories in this period.");
  assert(await inFrame(window, 'Array.from(document.querySelector("#category").options).some(option => option.value === "Food")'));
  await capture(window, "inflow-category.png");
  passed("Inflow-only categories are selectable and filter the summary and entries");
  await select(window, "category", "Food");
  assert((await content(window)).includes("12.54"));
  assert(!(await inFrame(window, 'document.getElementById("details").innerText')).includes("Inflow"));
  await select(window, "period", "custom");
  await select(window, "from", "2026-04-02");
  await select(window, "through", "2026-04-02");
  assert((await inFrame(window, 'document.getElementById("summary").innerText')).includes("0.20"));
  assert.equal(await inFrame(window, 'document.querySelectorAll(".entry").length'), 2);
  const beforeMonth = reads.get(window.webContents.id) ?? 0;
  await inFrame(window, 'document.getElementById("month").click(); true');
  await until(() => (reads.get(window.webContents.id) ?? 0) > beforeMonth, "month changes the query");
  await ready(window);
  assert.equal(await inFrame(window, 'document.getElementById("month").getAttribute("aria-pressed")'), "true");
  passed("Category and custom date filters preserve repeated records; day/month trend controls work");
  await select(window, "through", "2026-04-03");
  await select(window, "from", "2026-04-03");
  assert.equal(await inFrame(window, 'document.querySelectorAll(".entry").length'), 0);
  await capture(window, "empty.png");
  passed("A valid date range with no matching entries renders an empty state");

  await select(window, "period", "all");
  await select(window, "category", "");
  const initialFrame = frame(window).routingId;
  await fetch(new URL("/__mini-app-update", previewUrl), { method: "POST" });
  await hostClick(window, "Check for updates");
  await until(async () => (await inFrame(window, 'document.getElementById("summary").innerText')).includes("13.54"), "Data update arrives without template remount");
  assert.equal(frame(window).routingId, initialFrame);
  assert.equal(await inFrame(window, 'document.getElementById("currency").value'), "known:CNY");
  passed("Data revision refresh updates totals without remount or losing the selected currency");

  await fetch(new URL("/__mini-app-outage?on=1", previewUrl), { method: "POST" });
  await hostClick(window, "Check for updates");
  await until(() => evaluate(window, 'document.body.innerText.includes("Synthetic temporary outage")'), "temporary outage shown");
  assert((await content(window)).includes("13.54"));
  assert.equal(await evaluate(window, 'Array.from(document.querySelectorAll("[data-testid=mini-apps-panel] span")).some(node => node.textContent.trim() === "Current")'), false);
  await capture(window, "stale.png");
  await fetch(new URL("/__mini-app-outage", previewUrl), { method: "POST" });
  await hostClick(window, "Check for updates");
  await until(() => evaluate(window, '!document.body.innerText.includes("Synthetic temporary outage") && Array.from(document.querySelectorAll("[data-testid=mini-apps-panel] span")).some(node => node.textContent.trim() === "Current")'), "outage recovery");
  passed("Temporary outage retains the report with a stale state and recovers on refresh");

  await hostClick(window, "Inventory");
  await until(async () => frame(window) && (await content(window)).includes("Pencil: 7"), "generic inventory app");
  await evaluate(window, `(() => { const current = document.querySelector('[role="tab"][aria-selected="true"][data-app-id]'); current.focus(); current.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight",bubbles:true})); return true; })()`);
  await ready(window);
  passed("Generic inventory app uses the same host and keyboard app navigation returns to bookkeeping");

  await evaluate(window, 'document.querySelector("[data-testid=mini-apps-panel] details").open=true; true');
  await evaluate(window, `(() => { const b=[...document.querySelectorAll('[data-testid="mini-apps-panel"] details button')].find(x=>!x.disabled); if(!b)throw Error("No rollback");b.click(); return true; })()`);
  await until(() => evaluate(window, 'document.body.innerText.includes("Bookkeeping") && !document.body.innerText.includes("Synthetic bookkeeping records")'), "template rollback");
  await ready(window);
  assert((await content(window)).includes("13.54"));
  passed("Template rollback retains current Data");

  await hostClick(window, "Install bookkeeping");
  await until(() => evaluate(window, 'document.querySelectorAll("[data-testid=bookkeeping-install] select").length > 2'), "installer sources");
  await evaluate(window, `(() => {
    const form = document.querySelector('[data-testid="bookkeeping-install"]');
    const table = [...form.querySelectorAll("select")].find(select => [...select.options].some(option => option.textContent.startsWith("ledger_master ·")));
    if (!table) throw Error("Missing ledger table choice");
    table.value = [...table.options].find(option => option.textContent.startsWith("ledger_master ·")).value;
    table.dispatchEvent(new Event("change", {bubbles:true}));
    return true;
  })()`);
  await hostClick(window, "Preview rows");
  await until(() => evaluate(window, `document.querySelector('[data-testid="bookkeeping-install"] table')?.innerText.includes("Lunch")`), "selected ledger preview");
  await evaluate(window, `(() => {
    const label = [...document.querySelectorAll('[data-testid="bookkeeping-install"] label')].find(label => label.textContent.trim().startsWith("Editing assistant"));
    const select = label?.querySelector("select");
    if (!select || select.options.length < 2) throw Error("Missing editing assistant");
    select.value = select.options[1].value;
    select.dispatchEvent(new Event("change", {bubbles:true}));
    return true;
  })()`);
  await capture(window, "install.png");
  assert.equal(await evaluate(window, `(() => {
    const label = [...document.querySelectorAll('[data-testid="bookkeeping-install"] label')].find(label => label.textContent.trim().startsWith("Editing assistant"));
    const select = label.querySelector("select");
    return select.value === select.options[1].value;
  })()`), true);
  passed("Installer reads retained source metadata and an owner-only source preview");
  await hostClick(window, "Install portal");
  await until(() => evaluate(window, '!document.querySelector("[data-testid=bookkeeping-install]")'), "installation completes");
  await ready(window);
  await select(window, "currency", "known:CNY");
  assert((await content(window)).includes("13.54"));
  const installed = await evaluate(window, `fetch("/api/mini-apps").then(response => response.json()).then(list => list.apps.find(app => app.slug === "bookkeeping"))`);
  assert(installed, "installed bookkeeping app is discoverable");
  assert.equal(installed.publisherBotIds.length, 1, "the selected assistant receives the explicit publishing grant");
  await capture(window, "installed.png");
  passed("Installing the bookkeeping portal saves its column mapping and selected assistant, then queries retained Data");
} catch (error) {
  result.errors.push(error?.stack ?? String(error));
} finally {
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  clearTimeout(timer);
  writeFileSync(join(evidence, "mini-apps-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(result.errors.length ? 1 : 0);
}
}

void run();
