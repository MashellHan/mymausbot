import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchChrome, type ChromeProcess } from "../../server/browser/chrome/launch.ts";
import { CdpBrowser } from "../../server/browser/cdp/browser.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, installedChrome } from "./control-omb-ui.ts";

const enabled = process.env.OMB_PRIMARY_USAGE_UI === "1";

(enabled ? it : it.skip)("shows source-qualified contributions and keyboard account detail at narrow and wide widths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-primary-usage-"));
  const evidence = process.env.OMB_PRIMARY_USAGE_EVIDENCE_DIR || join(directory, "evidence");
  mkdirSync(evidence, { recursive: true });
  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "scripts/verify-usage.ts"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", url = "";
  child.stdout!.on("data", (part) => { output += String(part); });
  child.stderr!.on("data", (part) => { errors = (errors + String(part)).slice(-3000); });
  let chrome: ChromeProcess | undefined;
  let browser: CdpBrowser | undefined;
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Usage fixture exited: ${errors}`);
      for (const line of output.split("\n")) {
        try { url = JSON.parse(line).previewUrl || url; } catch { /* Vite startup output */ }
      }
      return url;
    }, { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const installed = [process.env.OMB_CDP_CHROME, installedChrome(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      .find((file): file is string => Boolean(file && existsSync(file)));
    const executablePath = installed ?? (await ensureUiBrowser()).chrome;
    if (!executablePath) throw new Error("Primary Usage checks require Chrome");
    chrome = await launchChrome({ executablePath, userDataDir: join(directory, "profile"), mode: "headless",
      host: "desktop", sandbox: process.env.OMB_BROWSER_SANDBOX !== "0" });
    browser = await CdpBrowser.connect(chrome.transport, { identity: null, viewport: { width: 1600, height: 900 } });
    const page = await browser.waitForPage();
    const read = <T>(expression: string) => page.evaluate(expression) as Promise<T>;
    for (const [width, locale, skin] of [[360, "en", "midnight"], [960, "zh", "atelier"]] as const) {
      await page.navigate(`${url.split("?")[0]}?width=${width}&locale=${locale}&skin=${skin}&scenario=known-counts`,
        { readiness: "domcontentloaded", timeoutMs: 45_000 });
      const explanation = () => read<string>("document.querySelector('[data-usage-metric-definition]')?.textContent ?? ''");
      await expect.poll(explanation, { timeout: 30_000 }).toContain(locale === "en" ? "PRs use creation time" : "PR 按创建时刻");
      expect(await explanation()).toContain(locale === "en" ? "Beijing time (UTC+8)" : "北京时间（UTC+8）");
      expect(await explanation()).toContain(locale === "en" ? "including merge commits" : "包括合并提交");
      await expect.poll(() => read<number>("document.querySelectorAll('[data-testid=local-usage-panel] section dd').length"),
        { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      const state = await read<{ sourceSelector: boolean; overflow: number; width: number; cards: string[]; rows: string }>(`(() => {
        const panel = document.querySelector('[data-testid="local-usage-panel"]');
        return { sourceSelector: Boolean(panel.querySelector('select[aria-label="Activity source"]')),
          overflow: panel.scrollWidth - panel.clientWidth, width: panel.getBoundingClientRect().width,
          cards: [...panel.querySelectorAll('section dd')].slice(0, 3).map(node => node.textContent.trim()),
          rows: panel.querySelector('[data-usage-repositories]')?.textContent ?? '' };
      })()`);
      expect(state.sourceSelector).toBe(false);
      expect(state.overflow).toBeLessThanOrEqual(1);
      expect(Math.abs(state.width - width)).toBeLessThanOrEqual(1);
      expect(state.cards[0]).toContain("≥5");
      expect(state.cards[1]).toContain("≥9");
      expect(state.cards[0]).toContain(locale === "en" ? "DoD New" : "日环比 新增");
      expect(await read<number>("document.querySelectorAll('section dl > div > dd > [data-usage-change][data-usage-provisional]').length")).toBe(6);
      expect(state.rows).toContain("fixture/github-repo");
      expect(state.rows).toContain("fixture/ado-repo");
      const topShot = await page.session.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(evidence, `primary-top-${width}-${locale}.png`), Buffer.from(topShot.data, "base64"));
      await read("document.querySelector('[data-usage-trend=commits] [data-usage-day=\"2026-11-03\"]').scrollIntoView({block:'center'}); document.querySelector('[data-usage-trend=commits] [data-usage-day=\"2026-11-03\"]').focus()");
      const tooltip = await read<{ text: string; paragraphs: number; nativeHints: number }>(`(() => {
        const node = document.querySelector('[data-usage-trend=commits] [role=tooltip]');
        return { text: node?.textContent ?? '', paragraphs: node?.querySelectorAll('p').length,
          nativeHints: node?.querySelectorAll('[title], [aria-description]').length };
      })()`);
      expect(tooltip.text).toMatch(/2026-11-03.*9.*5.*4/s);
      expect(tooltip.paragraphs).toBe(0);
      expect(tooltip.nativeHints).toBe(0);
      const hoverShot = await page.session.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(evidence, `primary-hover-${width}-${locale}.png`), Buffer.from(hoverShot.data, "base64"));
      await page.session.send("Page.bringToFront");
      await read("document.querySelector('[data-usage-primary-sources] summary').scrollIntoView({block:'center'}); document.querySelector('[data-usage-primary-sources] summary').focus()");
      expect(await read<boolean>("document.activeElement === document.querySelector('[data-usage-primary-sources] summary')")).toBe(true);
      await page.press("Enter");
      await expect.poll(() => read<boolean>("document.querySelector('[data-usage-primary-sources]').open")).toBe(true);
      expect(await read<string>("document.querySelector('[data-usage-primary-sources]').textContent")).toContain("fixture-ado");
      await read("document.querySelector('[data-testid=local-usage-panel]').scrollTop = document.querySelector('[data-testid=local-usage-panel]').scrollHeight");
      const shot = await page.session.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(evidence, `primary-${width}-${locale}.png`), Buffer.from(shot.data, "base64"));
    }
    await page.navigate(`${url.split("?")[0]}?width=360&locale=en&skin=midnight&scenario=beijing-partial`,
      { readiness: "domcontentloaded", timeoutMs: 45_000 });
    await expect.poll(() => read<string>("document.querySelector('[data-usage-metric-definition]')?.textContent ?? ''"),
      { timeout: 30_000 }).toContain("Today is partial through the shown cutoff");
    const boundary = await read<{ dates: string[]; counts: string[][]; changes: string[][]; trend: string; sources: string; overflow: number }>(`(() => {
      const panel = document.querySelector('[data-testid="local-usage-panel"]');
      const cards = [...panel.querySelectorAll('section')].slice(0, 3);
      return { dates: cards.map(card => card.querySelector('h3')?.parentElement?.textContent ?? ''),
        counts: cards.map(card => [...card.querySelectorAll('dl > div > dd > span:first-child')].slice(0, 2).map(node => node.textContent.trim())),
        changes: cards.map(card => [...card.querySelectorAll('dl > div > dd > [data-usage-change]')].slice(0, 2).map(node => node.getAttribute('data-usage-provisional') + ':' + node.querySelector('[aria-hidden="true"]')?.textContent)),
        trend: panel.querySelector('[data-usage-trend="prs"] [data-usage-day="2026-11-03"]')?.getAttribute('aria-label') ?? '',
        sources: panel.querySelector('[data-usage-primary-sources]')?.textContent ?? '',
        overflow: panel.scrollWidth - panel.clientWidth };
    })()`);
    expect(boundary.dates.every(date => date.includes("2026-11-03"))).toBe(true);
    expect(boundary.counts).toEqual([["≥3", "≥5"], ["≥3", "≥5"], ["≥3", "≥5"]]);
    expect(boundary.changes).toEqual([["true:DoD New", "true:DoD New"], ["true:WoW New", "true:WoW New"], ["true:30d New", "true:30d New"]]);
    expect(boundary.trend).toContain("Known subtotal");
    expect(boundary.sources).toContain("60d");
    expect(boundary.overflow).toBeLessThanOrEqual(1);
    await read("document.querySelector('[data-testid=local-usage-panel] select[aria-label=\"Trend range\"]').value = '60'; document.querySelector('[data-testid=local-usage-panel] select[aria-label=\"Trend range\"]').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-usage-daily]').open = true");
    await expect.poll(() => read<number>("document.querySelectorAll('[data-usage-daily] tbody tr').length")).toBe(60);
    const boundaryShot = await page.session.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(evidence, "primary-beijing-partial-360-en.png"), Buffer.from(boundaryShot.data, "base64"));
    console.info(JSON.stringify({ primaryUsageUi: "passed", evidence, widths: [360, 960], languages: ["en", "zh"] }));
  } finally {
    await browser?.close().catch(() => {});
    await chrome?.close(3000);
    await waitForExit(child, { signal: "SIGINT", graceMs: 10_000 });
    await removeTempDir(directory);
  }
}, 120_000);
