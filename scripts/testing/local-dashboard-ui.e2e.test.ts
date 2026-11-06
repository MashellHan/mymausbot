import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchChrome, type ChromeProcess } from "../../server/browser/chrome/launch.ts";
import { CdpBrowser } from "../../server/browser/cdp/browser.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, installedChrome } from "./control-omb-ui.ts";

const enabled = process.env.OMB_DASHBOARD_UI === "1";

async function fixture(script: string, children: ChildProcess[]): Promise<string> {
  const child = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "", errors = "", url = "";
  child.stdout!.on("data", (part) => { output += String(part); });
  child.stderr!.on("data", (part) => { errors = (errors + String(part)).slice(-3000); });
  await expect.poll(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
    for (const line of output.split("\n")) {
      try { url = JSON.parse(line).previewUrl || url; } catch { /* Vite startup output */ }
    }
    return url;
  }, { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:/);
  return url;
}

(enabled ? it : it.skip)("keeps dashboard bounds, daily values and selected office state through refresh", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-dashboard-ui-"));
  const children: ChildProcess[] = [];
  let chrome: ChromeProcess | undefined;
  let browser: CdpBrowser | undefined;
  try {
    const installed = [process.env.OMB_CDP_CHROME, installedChrome(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"]
      .find((file): file is string => Boolean(file && existsSync(file)));
    const executablePath = installed ?? (await ensureUiBrowser()).chrome;
    if (!executablePath) throw new Error("Dashboard assertions require Chrome");
    chrome = await launchChrome({ executablePath, userDataDir: join(directory, "profile"), mode: "headless", host: "desktop", sandbox: process.env.OMB_BROWSER_SANDBOX !== "0" });
    browser = await CdpBrowser.connect(chrome.transport, { identity: null, viewport: { width: 1600, height: 900 } });
    const page = await browser.waitForPage();
    const open = (url: string) => page.navigate(url, { readiness: "domcontentloaded", timeoutMs: 45_000 });
    const read = <T>(expression: string) => page.evaluate(expression) as Promise<T>;
    const usage = await fixture("scripts/verify-usage.ts", children);
    const agents = await fixture("scripts/verify-agent-team.ts", children);
    for (const width of [360, 400, 960]) {
      for (const locale of ["en", "zh"]) {
        const options = `width=${width}&locale=${locale}&skin=${locale === "en" ? "midnight" : "atelier"}`;
        await open(`${usage.split("?")[0]}?${options}&scenario=ready`);
        await expect.poll(() => read<number>("document.querySelectorAll('[data-usage-daily]').length"), { timeout: 30_000 }).toBe(1);
        expect(await read<boolean>("document.querySelector('[data-usage-daily]').open")).toBe(false);
        await read("document.querySelector('[data-usage-daily]').open = true");
        const geometry = await read<{ overflow: number; width: number; cells: number; dateRight: number; regionRight: number; wow: { left: number; right: number; text: string }[] }>(`(() => {
          const panel = document.querySelector('[data-testid="local-usage-panel"]');
          const region = panel.querySelector('[data-usage-daily] [role=region]');
          region.scrollLeft = region.scrollWidth;
          const row = region.querySelector('tbody tr');
          return { overflow: panel.scrollWidth - panel.clientWidth, width: panel.getBoundingClientRect().width, cells: row.querySelectorAll('td').length,
            dateRight: row.querySelector('th').getBoundingClientRect().right, regionRight: region.getBoundingClientRect().right,
            wow: Array.from(row.querySelectorAll('td:last-child span')).map(span => ({ left: span.getBoundingClientRect().left, right: span.getBoundingClientRect().right, text: span.textContent })) };
        })()`);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.width - width)).toBeLessThanOrEqual(1);
        expect(geometry.cells).toBeGreaterThanOrEqual(4);
        expect(geometry.wow).toHaveLength(6);
        for (const value of geometry.wow) {
          expect(value.text.length).toBeGreaterThan(0);
          expect(value.left).toBeGreaterThanOrEqual(geometry.dateRight - 1);
          expect(value.right).toBeLessThanOrEqual(geometry.regionRight + 1);
        }
        await open(`${agents.split("?")[0]}?${options}&scenario=live`);
        await expect.poll(() => read<number>("document.querySelectorAll('[data-team-house]').length"), { timeout: 30_000 }).toBe(2);
        expect(await read<number>("document.querySelectorAll('[data-testid=selected-agent-team]').length")).toBe(0);
        await read("document.querySelector('[data-team-house]').click()");
        await expect.poll(() => read<number>("document.querySelectorAll('[data-testid=selected-agent-team]').length")).toBe(1);
        expect(await read<number>("(() => { const p = document.querySelector('[data-testid=agent-team-panel]'); return p.scrollWidth - p.clientWidth; })()")).toBeLessThanOrEqual(1);
      }
    }
    await open(`${agents.split("?")[0]}?width=360&locale=en&scenario=live`);
    await expect.poll(() => read<number>("document.querySelectorAll('[data-team-house]').length")).toBe(2);
    await read("document.querySelector('[data-team-house]').click()");
    await expect.poll(() => read<number>("document.querySelectorAll('[data-testid=selected-agent-team]').length")).toBe(1);
    const before = await read<{ top: number; selected: string }>(`(() => {
      const panel = document.querySelector('[data-testid=agent-team-panel]');
      const button = document.querySelector('[data-team-house][aria-pressed=true]');
      button.focus({ preventScroll: true }); panel.scrollTop = 20;
      return { top: panel.scrollTop, selected: button.dataset.teamHouse };
    })()`);
    expect(before.top).toBeGreaterThan(0);
    const response = await fetch(new URL("/__agent-team-update", agents), { method: "POST" });
    expect(response.ok).toBe(true);
    await expect.poll(() => read<string>("document.querySelector('[data-testid=selected-agent-team]').textContent"), { timeout: 10_000 }).toContain("Only the newest synthetic instruction");
    expect(await read("({ top: document.querySelector('[data-testid=agent-team-panel]').scrollTop, selected: document.activeElement?.dataset.teamHouse })")).toEqual(before);
    await read("document.querySelectorAll('[data-team-house]')[1].click()");
    await expect.poll(() => read<string>("document.querySelector('[data-testid=selected-agent-team]').textContent")).toContain("Lark");
    expect(await read<string>("document.querySelector('[data-testid=selected-agent-team]').textContent")).not.toContain("Only the newest synthetic instruction");
  } finally {
    await browser?.close().catch(() => {});
    await chrome?.close(3000);
    for (const child of children) await waitForExit(child, { signal: "SIGINT", graceMs: 10_000 });
    await removeTempDir(directory);
  }
}, 120_000);
