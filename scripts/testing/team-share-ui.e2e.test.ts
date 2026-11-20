import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping share-team UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

describe("Share a department in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("department … → Share shows one card with no fields, offers the folder when publishing isn't here, and saves it", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const control = (...args: string[]) => runControlOmb([...args, "--url", info.url]) as Promise<Record<string, any>>;

    await api(`/api/bots/${info!.botId}`, "PATCH", { section: "Sales desk", chiefOfStaff: true, soul: "Lead the desk. The admin key is sk-ant-api03-UIFIXTURESECRET0000000000000.\n" });
    await control("new-bot", "--name", "Scout", "--section", "Sales desk");
    await api(`/api/section-context?section=${encodeURIComponent("Sales desk")}`, "PUT", { text: "Quote list prices only." });
    await api(`/api/bots/${info!.botId}/memory/file`, "PUT", { path: "MEMORY.md", text: "- UI_FIXTURE_MEMORY prefers short summaries.\n" });
    // Capture the saved folder instead of letting the headless browser download it.
    await evaluate(`(() => {
      URL.createObjectURL = (blob) => { window.__shareBlob = blob; return "blob:share-fixture"; };
      HTMLAnchorElement.prototype.click = function () { window.__shareDownload = this.download; };
      return true;
    })()`);

    const handle = JSON.parse(readFileSync(info!.ui, "utf8")) as UiHandle;
    await agentBrowser(handle.binary, sessionEnv(handle), ["set", "viewport", "1280", "900"]);
    await expect.poll(() => evaluate("innerWidth"), { timeout: 10_000 }).toBe(1280);
    const triggerSelector = 'button[aria-label="Actions for Sales desk department"]';
    try {
      await expect.poll(() => evaluate(`(() => {
        const triggers = document.querySelectorAll(${JSON.stringify(triggerSelector)});
        if (triggers.length !== 1) return false;
        const trigger = triggers[0];
        if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || !trigger.checkVisibility()) return false;
        const { left, top, width, height } = trigger.getBoundingClientRect();
        if (width <= 0 || height <= 0) return false;
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return hit === trigger || trigger.contains(hit);
      })()`), { timeout: 10_000 }).toBe(true);
      await click("Actions for Sales desk department");
      await expect.poll(() => evaluate(`document.querySelector(${JSON.stringify(triggerSelector)})?.getAttribute('aria-expanded') ?? null`), { timeout: 10_000 }).toBe("true");
      await expect.poll(() => evaluate(`(() => {
        const menu = document.querySelector('[role="menu"][aria-label="Sales desk"]');
        if (!menu || !menu.checkVisibility() || menu.closest('[inert], [aria-hidden="true"]')) return false;
        const shares = [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => item.textContent?.trim() === "Share");
        return shares.length === 1 && shares[0].checkVisibility();
      })()`), { timeout: 10_000 }).toBe(true);
      await click("Share");
    } catch (error) {
      const diag = await evaluate(`(() => {
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        const menu = document.querySelector('[role="menu"][aria-label="Sales desk"]');
        const rect = trigger?.getBoundingClientRect();
        const hit = rect && rect.width > 0 && rect.height > 0 ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          innerWidth,
          triggerCount: document.querySelectorAll(${JSON.stringify(triggerSelector)}).length,
          ariaExpanded: trigger?.getAttribute('aria-expanded') ?? null,
          hitTag: hit ? hit.tagName.toLowerCase() : null,
          menuVisible: Boolean(menu?.checkVisibility() && !menu.closest('[inert], [aria-hidden="true"]')),
          menuItems: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()) : [],
        };
      })()`).catch(() => null);
      throw new Error(`${error instanceof Error ? error.message : String(error)} (share menu diag: ${JSON.stringify(diag)})`);
    }
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Chats, memory and keys are never shared");
    const dialog = await snapshot();
    for (const line of ["Share Sales desk", "Publishing isn't available here", "Upload on GitHub", "Save folder…"]) expect(dialog).toContain(line);
    expect(dialog, "shared instructions are not the card's line").not.toContain("Quote list prices only.");
    expect(await evaluate("document.querySelector('[data-share-department]').closest('[role=dialog]').querySelectorAll('input, textarea, select, [role=checkbox]').length")).toBe(0);
    await ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", "share-department.png"));
    await click("Save folder…");
    await expect.poll(() => evaluate("window.__shareDownload ?? null"), { timeout: 10_000 }).toBe("Sales desk.zip");
    await evaluate("window.__shareBlob.arrayBuffer().then((buffer) => { window.__shareText = new TextDecoder('latin1').decode(buffer); }); true");
    await expect.poll(async () => typeof (await evaluate("window.__shareText")), { timeout: 5_000 }).toBe("string");
    const zip = await evaluate("window.__shareText") as string;
    expect(zip.startsWith("PK")).toBe(true);
    expect(zip).toContain("team.md");
    expect(zip).not.toContain("UIFIXTURESECRET");
    expect(zip).not.toContain("UI_FIXTURE_MEMORY");
    await click("Close");
    process.stdout.write(`${JSON.stringify({ fixture: info!, departmentShared: true, savedZip: true })}\n`);
  }, launchTimeout + 120_000);
});
