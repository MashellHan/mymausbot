import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { handleToolCall, request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "./cleanup.ts";
import { readHandoffs } from "./handoff-rows.ts";

export async function withRooms(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  let restarted: ChildProcess | undefined;
  const restart = async (signal: NodeJS.Signals) => {
    await waitForExit(restarted ?? session.child, { signal });
    const log = openSync(session.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", log, log],
      env: verificationServerEnvironment(process.env, session.info.dataDir, Number(new URL(session.info.url).port)) });
    closeSync(log);
    await expect.poll(() => fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) }).then(r => r.ok, () => false), { timeout: 20_000 }).toBe(true);
  };
  try {
    const sender = (await cli("new-bot", "--name", "Director", "--section", "A")).bot;
    const target = (await cli("new-bot", "--name", "Engineer", "--section", "A")).bot;
    const source = (await tool("create_channel", { name: "Planning", member_ids: [sender.id], bulletin: "SOURCE_ONLY" })).channel;
    const destination = (await tool("create_channel", { name: "Engineering", member_ids: [target.id], bulletin: "DESTINATION_ONLY" })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [sender.id]: { steps: [{ arguments: { group_id: destination.id, bot_ids: [target.id], message: "Please build CSV" } }], reply: "Assigned", resumeReply: "Reviewed downstream outcome" },
      [target.id]: { reply: "Built CSV" },
    };
    const savePlan = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => readHandoffs(session.info.dataDir);
    const handoffs = () => nodes().filter((node: any) => node.parentId);
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { savePlan(); return cli("send-channel", "--channel", source.id, "--text", "@Director Start the assignment"); };
    const wait = async () => cli("wait", "--channel", source.id, "--timeout", "30");
    const provider = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await test({ session, api, cli, tool, sender, target, source, destination, plan, savePlan, nodes, handoffs, messages, start, wait, provider, restart });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}
