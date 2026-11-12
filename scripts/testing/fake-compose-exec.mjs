import { spawnSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";

const args = readFileSync(process.argv[2], "utf8").split("\0");
if (args.pop() !== "" || !args[0]) throw new Error("invalid fake Docker helper arguments");
const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
writeSync(3, `exit ${result.status}\n`);
