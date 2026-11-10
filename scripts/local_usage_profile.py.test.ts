import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const suite = fileURLToPath(new URL("./local_usage_profile.test.py", import.meta.url));

it("runs the isolated GitHub Profile v2 Python contracts", () => {
  const result = spawnSync("python3", ["-B", suite], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran \d+ tests? in/);
});
