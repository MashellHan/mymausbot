import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("rechecks changed source and imported types while keeping independent UI/server compiler state", () => {
  const root = mkdtempSync(join(tmpdir(), "mausbot-typecheck-"));
  const script = fileURLToPath(new URL("./typecheck.mjs", import.meta.url));
  const run = (ci = "") => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: { ...process.env, CI: ci } });
  const write = (file: string, value: string) => writeFileSync(join(root, file), value);
  try {
    const options = { strict: true, noEmit: true, types: [], target: "ES2023", module: "ESNext", moduleResolution: "bundler", skipLibCheck: true };
    write("tsconfig.json", JSON.stringify({ compilerOptions: options, files: ["ui.ts"] }));
    write("tsconfig.server.json", JSON.stringify({ compilerOptions: options, files: ["server.ts"] }));
    write("ui.ts", "export const value: number = 1;\n");
    write("model.ts", "export type Count = number;\n");
    write("server.ts", "import type { Count } from './model'; export const count: Count = 1;\n");
    const cold = run();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    for (const project of ["ui", "server"]) {
      const state = JSON.parse(readFileSync(join(root, ".omb-scratch/typecheck", `${project}.tsbuildinfo`), "utf8"));
      expect(state.fileNames.length).toBeGreaterThan(0);
    }
    const warm = run();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(warm.stdout).toContain("Typecheck server:");
    write("ui.ts", "export const value: number = 'wrong';\n");
    const brokenUi = run();
    expect(brokenUi.status).toBe(2);
    expect(brokenUi.stdout).toContain("TS2322");
    write("ui.ts", "export const value: number = 1;\n");
    write("model.ts", "export type Count = string;\n");
    const brokenImport = run();
    expect(brokenImport.status).toBe(2);
    expect(brokenImport.stdout).toContain("server.ts");
    write("model.ts", "export type Count = number;\n");
    const recovered = run("true");
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    expect(recovered.stdout.match(/fresh/g)).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
