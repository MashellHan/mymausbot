import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyPrivateBrowserFuse } from "./private-cookie-fuse.mjs";

const marker = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const wire = bits => Buffer.concat([Buffer.from([1, 9]), Buffer.from(bits)]);

function fixture(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-cookie-fuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = path.join(root, "Fixture.app", "Contents");
  const executable = path.join(contents, "MacOS", "Fixture");
  const framework = path.join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(framework), { recursive: true });
  fs.writeFileSync(executable, "fixture");
  fs.writeFileSync(framework, bytes);
  return { runtime: { platform: "darwin", versions: { electron: "43.7.9" }, execPath: executable }, framework };
}

test("the actual running Framework must have one supported cookie-encryption fuse disabled", t => {
  const { runtime, framework } = fixture(t, Buffer.concat([Buffer.alloc(1024 * 1024 - 10), marker, wire("101100011")]));
  assert.doesNotThrow(() => verifyPrivateBrowserFuse(runtime));
  fs.writeFileSync(framework, Buffer.concat([marker, wire("111100011")]));
  assert.throws(() => verifyPrivateBrowserFuse(runtime), /unavailable/);
  fs.writeFileSync(framework, Buffer.concat([marker, Buffer.from([2, 9]), Buffer.from("101100011")]));
  assert.throws(() => verifyPrivateBrowserFuse(runtime), /unavailable/);
  fs.writeFileSync(framework, Buffer.concat([marker, wire("101100011"), marker, wire("101100011")]));
  assert.throws(() => verifyPrivateBrowserFuse(runtime), /unavailable/);
  fs.writeFileSync(framework, Buffer.from("unknown framework"));
  assert.throws(() => verifyPrivateBrowserFuse(runtime), /unavailable/);
  assert.throws(() => verifyPrivateBrowserFuse({ ...runtime, versions: { electron: "43.8.0" } }), /unavailable/);
});
