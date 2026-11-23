import { startBridge } from "./bridge.ts";
import { loadConfig } from "./config.ts";
import { createJsonLogger } from "./log.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  process.stderr.write(`pwa-relay: ${(error as Error).message}\n`);
  process.exit(1);
}

const log = createJsonLogger();
const bridge = await startBridge(config, { log });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), config.shutdownMs).unref();
  bridge
    .drain()
    .then(() => bridge.close())
    .finally(() => {
      log({ ev: "stop" });
      process.exit(0);
    });
};

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
