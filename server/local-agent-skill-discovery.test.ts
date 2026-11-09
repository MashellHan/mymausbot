import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { discoverCodexSkills } from "./local-agent-skill-discovery.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

it("uses Codex skills/list for one cwd and includes only enabled, named skill paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mausbot-codex-skills-"));
  folders.push(cwd);
  const cli = join(cwd, "fake-codex");
  await writeFile(cli, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    if (request.method === "skills/list") process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{
      cwd: request.params.cwds[0], skills: [
        { name: "agent-desktop", path: "/synthetic/agent-desktop/SKILL.md", enabled: true },
        { name: "disabled", path: "/synthetic/disabled/SKILL.md", enabled: false },
        { name: "duplicate", path: "/synthetic/agent-desktop/SKILL.md", enabled: true },
      ], errors: [] }] } }) + "\\n");
  }
});
`);
  await chmod(cli, 0o755);
  expect(await discoverCodexSkills(cwd, { cli })).toEqual({ status: "ready", skills: [
    { name: "agent-desktop", path: "/synthetic/agent-desktop/SKILL.md" },
  ] });
});
