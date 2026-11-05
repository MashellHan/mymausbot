import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { BROWSER_SIGN_IN } from "./request-auth.ts";

describe("local dashboard authorization in an isolated server", () => {
  it("registers the owner route and refuses paired, proxied and unsigned browser callers", async () => {
    const fixture = await launchVerificationServer({ OMB_DEV_TRUST_LOCAL_BROWSER: "0" });
    const url = fixture.info.url;
    try {
      const owner = await fetch(`${url}/api/local-dashboard/agents`);
      expect(owner.status).toBe(200);
      expect(await owner.json()).toEqual({ status: "unavailable", updatedAt: null, teamCount: null, teams: [] });
      const ownerActivity = await fetch(`${url}/api/local-dashboard/agents/w6%3Ap1/activity`);
      expect(ownerActivity.status).toBe(200);
      expect(await ownerActivity.json()).toEqual({ agentId: "w6:p1", status: "unavailable", updatedAt: null, truncated: false, events: [] });
      const ownerUsage = await fetch(`${url}/api/local-dashboard/usage`);
      expect(ownerUsage.status).toBe(200);
      expect(await ownerUsage.json()).toEqual({ status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
        sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] });

      const opened = await fetch(`${url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const { code } = await opened.json() as { code: string };
      const paired = await fetch(`${url}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: "Fixture phone" }) });
      const { token } = await paired.json() as { token: string };
      expect(token).toMatch(/^omb_sess_/);
      expect((await fetch(`${url}/api/local-dashboard/agents`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
      expect((await fetch(`${url}/api/local-dashboard/usage`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
      expect((await fetch(`${url}/api/local-dashboard/agents/w6%3Ap1/activity`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
      expect((await fetch(`${url}/api/local-dashboard/agents`, { headers: { "x-forwarded-for": "203.0.113.8" } })).status).toBe(403);
      expect((await fetch(`${url}/api/local-dashboard/usage`, { headers: { "x-forwarded-for": "203.0.113.8" } })).status).toBe(403);
      expect((await fetch(`${url}/api/local-dashboard/agents/w6%3Ap1/activity`, { headers: { "x-forwarded-for": "203.0.113.8" } })).status).toBe(403);

      const browser = await fetch(`${url}/api/local-dashboard/agents`, { headers: {
        origin: url, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
      } });
      expect(browser.status).toBe(401);
      expect((await browser.json() as { error: string }).error).toBe(BROWSER_SIGN_IN);
      expect((await fetch(`${url}/api/local-dashboard/agents/w6%3Ap1/activity`, { headers: {
        origin: url, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
      } })).status).toBe(401);
    } finally { await fixture.close(); }
  }, 60_000);
});
