import { join } from "node:path";
import { boxCpus } from "../box-cpus.ts";
import { boxMemory } from "../box-memory.ts";
import { DATA_TMP_DIR } from "./storage.ts";

/** DuckDB's defaults assume it owns the machine (80 % of RAM, every core), and a native OOM takes the server down. A
 * container's limits count, not its host's: each thread also counts against the container's pids limit. */
export function instanceSettings(folder: string, dataDir: string, duckdbVersion: string, env: NodeJS.ProcessEnv = process.env,
  box: { cpus: number; memoryBytes: number } = { cpus: boxCpus(), memoryBytes: boxMemory().bytes }): Record<string, string> {
  const quarterOfRam = Math.floor(box.memoryBytes / 4);
  const memoryMiB = Math.max(256, Math.floor(Math.min(2 * 1024 ** 3, quarterOfRam) / 1024 ** 2));
  return {
    memory_limit: env.OMB_DUCKDB_MEMORY_LIMIT || `${memoryMiB}MiB`,
    temp_directory: join(folder, DATA_TMP_DIR),
    max_temp_directory_size: env.OMB_DUCKDB_MAX_TEMP_SIZE || "20GB",
    threads: String(Math.max(1, Math.min(4, Math.floor(box.cpus) || 1))),
    // Extensions are tied to the exact DuckDB version.
    extension_directory: join(dataDir, "duckdb-extensions", duckdbVersion),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "true",
    // Persistent secrets sit unencrypted on disk; OMB's broker issues temporary ones.
    allow_persistent_secrets: "false",
    preserve_insertion_order: "false",
  };
}
