import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { interpolate } from "./testing/github-expression.ts";

const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const preparation = parse(readFileSync(new URL("../.github/workflows/prepare-release.yml", import.meta.url), "utf8"));

describe("desktop release destinations", () => {
  it("keeps personal release and branch collision checks while limiting the legacy mirror check to upstream", () => {
    const run = preparation.jobs.prepare.steps.find((step: { name?: string }) => step.name === "Refuse an existing release or release branch").run;
    const personal = run.indexOf('gh release view "v$VERSION" --repo "$GITHUB_REPOSITORY"');
    const mirror = run.indexOf('if [ "$GITHUB_REPOSITORY" = milind-soni/OpenMausBot ] && gh release view "v$VERSION" --repo milind-soni/openmausbot-releases');
    const branch = run.indexOf('git ls-remote --exit-code --heads origin "release/v$VERSION"');
    expect(personal).toBeGreaterThanOrEqual(0);
    expect(mirror).toBeGreaterThan(personal);
    expect(branch).toBeGreaterThan(mirror);
  });

  it.each(["MashellHan/mymausbot", "milind-soni/OpenMausBot"])("keeps legacy mirroring scoped to its owner in %s", repository => {
    const expected = repository === "milind-soni/OpenMausBot";
    const context = { github: { repository }, steps: { pin: { outputs: { should_release: "true" } } } };
    for (const name of ["Refuse to overwrite a published legacy mirror", "Mirror the same draft for installed legacy clients"]) {
      const step = [...release.jobs.prepare.steps, ...release.jobs.assemble.steps].find((step: { name?: string }) => step.name === name);
      expect(interpolate(`\${{ ${step.if} }}`, context)).toBe(expected);
    }
  });

  it.each([
    ["MashellHan/mymausbot", ["MashellHan/mymausbot"]],
    ["milind-soni/OpenMausBot", ["milind-soni/OpenMausBot", "milind-soni/openmausbot-releases"]],
  ])("verifies only the release destinations owned by %s", (repository, expected) => {
    const run = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Prove release drafts contain the exact staged bytes").run;
    const script = /<<'EOF'\n([\s\S]*?)\nEOF/.exec(run)![1].replace(/^import .*;\n/gm, "");
    const bytes = Buffer.from("fixture desktop package");
    const name = "mymausbot-0.1.0-arm64.zip";
    const repos: string[] = [];
    runInNewContext(script, {
      createHash,
      readFileSync: () => bytes,
      readdirSync: () => [name],
      join: (...parts: string[]) => parts.join("/"),
      process: { argv: ["node", "-", "0.1.0"], env: { GITHUB_REPOSITORY: repository } },
      console: { log() {} },
      execFileSync: (command: string, args: string[]) => {
        expect(command).toBe("gh");
        repos.push(args[args.indexOf("--repo") + 1]);
        return JSON.stringify({ assets: [{ name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }] });
      },
    });
    expect(repos).toEqual(expected);
  });
});
