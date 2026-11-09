// A real Files component and message-scoped downloads, in a throwaway home.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "File reviewer"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "File reviewer");
  const workspace = join(fixture.info.dataDir, "sample-project");
  mkdirSync(workspace, { recursive: true });
  await api("PATCH", `/api/bots/${bot.id}`, { cwd: workspace, computer: "off" });
  const files = {
    "report #1.md": "# Weekly review\n\nThis is a **synthetic report** for file preview.\n\n## Highlights\n\n- Alpha shipped twelve changes.\n- Beta completed seven improvements.\n\n| Project | Changes |\n| --- | ---: |\n| Alpha | 12 |\n| Beta | 7 |\n\n```text\nrelease-2026-11\n```\n\n[Private file](file:///private/unshared.md)\n\n<script>window.previewUnsafe = true</script>\n",
    "metrics.csv": 'Project,Changes,Code,Notes\nAlpha,12,001,"Ready, reviewed"\nBeta,7,002,"Line one\nLine two"\n',
    "missing.md": "Removed after the turn.\n",
    "unshared.txt": "Changed, but never shared in a message.\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
  const reply = ["The report and table are ready.",
    ...["report #1.md", "metrics.csv", "missing.md"].map((name) => `[${name}](${pathToFileURL(join(workspace, name)).href})`),
  ].join("\n\n");
  const wrapper = join(fixture.info.dataDir, "files-claude.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  const sent = await control(["send", "--bot", bot.id, "--text", "Prepare the sample report and table."]);
  await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  const { messages } = await api("GET", `/api/threads/${sent.taskId}/messages?limit=100`);
  if (!messages.some((message: { text?: string }) => message.text === reply)) {
    throw new Error("Fixture did not produce the shared-file reply");
  }
  rmSync(join(workspace, "missing.md"));
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/computer-files-preview.tsx", route: "/__computer-files.html", title: "Isolated OMB files",
    extraRoutes: [{ path: "/__computer-files-fixture", handler: async (_req, res) => {
      const current = await api("GET", "/api/bots");
      const shown = current.bots.find((item: { id: string }) => item.id === bot.id);
      // The sealed launcher deliberately has no Git on PATH. Supply only
      // the renderer's digest rows; every download still needs the real
      // persisted reply and is checked by the unmodified server endpoint.
      const digest = { id: "fixture-digest", role: "bot", kind: "digest", at: Date.now(),
        parentId: shown.activeLeafId ?? shown.messages.at(-1)?.id,
        digest: { files: { added: Object.keys(files), changed: [], deleted: [] } } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...shown, messages: [...shown.messages, digest], activeLeafId: digest.id }));
    } }],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id, taskId: sent.taskId }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
