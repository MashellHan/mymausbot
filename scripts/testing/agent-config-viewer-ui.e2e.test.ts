import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, installedChrome } from "./control-omb-ui.ts";

const enabled = process.env.OMB_AGENT_CONFIG_UI === "1";

(enabled ? it : it.skip)("opens verified Agent, Skills and Team rules in a keyboard-safe narrow drawer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-agent-config-ui-"));
  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "scripts/verify-agent-team.ts"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", previewUrl = "";
  child.stdout!.on("data", (part) => { output += String(part); });
  child.stderr!.on("data", (part) => { errors = (errors + String(part)).slice(-3000); });
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
      for (const line of output.split("\n")) {
        try { previewUrl = JSON.parse(line).previewUrl || previewUrl; } catch {}
      }
      return previewUrl;
    }, { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:/);
    process.env.OMB_CDP_CHROME ??= installedChrome() ?? (await ensureUiBrowser()).chrome;
    const { openHeadlessChrome } = await import("./headless-chrome.ts");
    const page = await openHeadlessChrome(join(directory, "profile"));
    try {
      const key = async (name: string, modifiers = 0) => {
        const code = name === "Tab" ? 9 : name === "Escape" ? 27 : 39;
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
      };
      for (const [width, viewport, locale] of [[960, 1400, "en"], [360, 360, "zh"]] as const) {
        await page.send("Emulation.setDeviceMetricsOverride", { width: viewport, height: 900, deviceScaleFactor: 1, mobile: false });
        const url = `${previewUrl.split("?")[0]}?mode=simple&width=${width}&locale=${locale}&scenario=ready&skin=${locale === "en" ? "atelier" : "midnight"}`;
        await page.send("Page.navigate", { url });
        await page.until("document.querySelector('[data-agent-id=\"w6:p1\"] button[aria-haspopup=dialog]') && document.querySelectorAll('[data-team-house]').length === 2");
        const panelBounds = await page.evaluate("(() => { const panel = document.querySelector('[data-testid=agent-team-panel]'); const rect = panel.getBoundingClientRect(); return { overflow: panel.scrollWidth - panel.clientWidth, left: rect.left, right: rect.right, viewport: innerWidth }; })()");
        expect(panelBounds.overflow).toBeLessThanOrEqual(1);
        expect(panelBounds.left).toBeGreaterThanOrEqual(0);
        expect(panelBounds.right).toBeLessThanOrEqual(panelBounds.viewport + 1);
        if (process.env.OMB_AGENT_CONFIG_CAPTURE_DIR) {
          mkdirSync(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, { recursive: true });
          writeFileSync(join(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, `${width}-${locale}-panel.png`), await page.capture({ x: 0, y: 0, width: viewport, height: 900 }));
        }
        await page.evaluate("document.querySelector('[data-agent-id=\"w6:p1\"] button[aria-haspopup=dialog]').focus(); document.querySelector('[data-agent-id=\"w6:p1\"] button[aria-haspopup=dialog]').click()");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.textContent?.includes('Synthetic Agent instructions')");
        await page.until("document.activeElement?.getAttribute('data-testid') === 'agent-config-viewer'");
        await key("Tab", 8);
        expect(await page.evaluate("document.activeElement?.getAttribute('role')")).toBe("tab");
        await key("Tab");
        expect(await page.evaluate("document.activeElement?.getAttribute('aria-label')")).toBe(locale === "en" ? "Close" : "关闭");
        await key("Tab");
        expect(await page.evaluate("document.activeElement?.getAttribute('role')")).toBe("tab");
        await key("Tab", 8);
        expect(await page.evaluate("document.activeElement?.getAttribute('aria-label')")).toBe(locale === "en" ? "Close" : "关闭");
        await key("Tab", 8);
        expect(await page.evaluate("document.activeElement?.getAttribute('role')")).toBe("tab");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.getBoundingClientRect().right <= innerWidth + 1", 3_000);
        const geometry = await page.evaluate(`(() => {
          const drawer = document.querySelector('[data-testid=agent-config-viewer]');
          const close = drawer.querySelector('button[aria-label]');
          const tabs = drawer.querySelectorAll('[role=tab]');
          const rect = (item) => item.getBoundingClientRect();
          return { viewport: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
            drawer: { left: rect(drawer).left, right: rect(drawer).right, width: rect(drawer).width },
            close: { left: rect(close).left, right: rect(close).right },
            tabs: Array.from(tabs, (tab) => ({ left: rect(tab).left, right: rect(tab).right })),
            activeLinks: drawer.querySelectorAll('a[href], script, img').length };
        })()`);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.drawer.left).toBeGreaterThanOrEqual(0);
        expect(geometry.drawer.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.close.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.tabs).toHaveLength(2);
        expect(geometry.activeLinks).toBe(0);
        if (process.env.OMB_AGENT_CONFIG_CAPTURE_DIR) {
          mkdirSync(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, { recursive: true });
          writeFileSync(join(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, `${width}-${locale}-geometry.json`), JSON.stringify(geometry, null, 2) + "\n");
          writeFileSync(join(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, `${width}-${locale}-agent.png`), await page.capture({ x: 0, y: 0, width: viewport, height: 900 }));
        }
        await key("ArrowRight");
        await page.until("document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('Skills') || document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('技能')");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.textContent?.includes('herdr')");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.textContent?.includes('agent-desktop')");
        const skillCopy = await page.evaluate("document.querySelector('[data-testid=agent-config-viewer]')?.textContent ?? ''");
        expect(skillCopy).toContain(locale === "en" ? "Enabled and discoverable in Codex for this workspace" : "Codex 在此工作区已启用并可发现");
        expect(skillCopy).not.toContain(locale === "en" ? "No declared or enabled Codex skills were found" : "未发现已声明或 Codex 已启用的技能");
        const skillsOverflow = await page.evaluate("(() => { const panel = document.querySelector('[role=tabpanel]'); return panel.scrollWidth - panel.clientWidth; })()");
        expect(skillsOverflow).toBeLessThanOrEqual(1);
        if (process.env.OMB_AGENT_CONFIG_CAPTURE_DIR) writeFileSync(join(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, `${width}-${locale}-skills.png`),
          await page.capture({ x: 0, y: 0, width: viewport, height: 900 }));
        await page.evaluate("Array.from(document.querySelectorAll('[data-testid=agent-config-viewer] li button')).find((button) => button.textContent.includes('herdr')).click()");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.textContent?.includes('SKILL.md')");
        await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        await page.until("!document.querySelector('[data-testid=agent-config-viewer]')");
        expect(await page.evaluate("document.activeElement?.closest('[data-agent-id]')?.dataset.agentId")).toBe("w6:p1");
        await page.until("Array.from(document.querySelectorAll('[data-testid=selected-agent-team] button')).some((button) => button.textContent.includes('Team rules') || button.textContent.includes('团队总规则'))");
        await page.evaluate("Array.from(document.querySelectorAll('[data-testid=selected-agent-team] button')).find((button) => button.textContent.includes('Team rules') || button.textContent.includes('团队总规则')).click()");
        await page.until("document.querySelector('[data-testid=agent-config-viewer]')?.textContent?.includes('Synthetic playbook.md')");
        if (process.env.OMB_AGENT_CONFIG_CAPTURE_DIR) writeFileSync(join(process.env.OMB_AGENT_CONFIG_CAPTURE_DIR, `${width}-${locale}-rules.png`),
          await page.capture({ x: 0, y: 0, width: viewport, height: 900 }));
        await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        await page.until("!document.querySelector('[data-testid=agent-config-viewer]')");
      }
    } finally { page.close(); }
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 10_000 });
    await removeTempDir(directory);
  }
}, 120_000);
