import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps remote ADO attribution and coverage bound to synthetic API evidence", () => {
  const suite = fileURLToPath(new URL("./local_usage_ado.test.py", import.meta.url));
  const result = spawnSync("python3", [suite], { encoding: "utf8", timeout: 15_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran \d+ tests?/);
});
