import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseCompleteJsonLines } from "./complete-json-lines.ts";

it("reads only completed JSONL records and still rejects a malformed completed record", () => {
  const home = mkdtempSync(join(tmpdir(), "omb-complete-jsonl-"));
  const file = join(home, "events.jsonl");
  const read = () => parseCompleteJsonLines<{ n: number }>(readFileSync(file, "utf8"));
  try {
    writeFileSync(file, '{"n":1}\n{"n":');
    expect(read()).toEqual([{ n: 1 }]);
    appendFileSync(file, '2}\n');
    expect(read()).toEqual([{ n: 1 }, { n: 2 }]);
    appendFileSync(file, 'not-json\n');
    expect(read).toThrow(SyntaxError);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
