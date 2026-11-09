import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureProductIdentity } from "./product-identity.mjs";

function fixture(t, { name = "mymausbot", packaged = true, custom = false, explicit = false, legacy = true, customSession = false, legacyName = "OpenMausBot" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mymausbot-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, "Application Support");
  const legacyProfile = path.join(appData, legacyName);
  if (legacy) {
    mkdirSync(legacyProfile, { recursive: true });
    writeFileSync(path.join(legacyProfile, "desktop-prefs.json"), '{"credentialMode":"session","language":"zh"}');
  }
  const initialProfile = custom ? path.join(root, "fixture-profile") : path.join(appData, name);
  const paths = { appData, userData: initialProfile, sessionData: customSession ? path.join(root, "custom-session") : initialProfile };
  const app = {
    isPackaged: packaged,
    commandLine: { hasSwitch: key => key === "user-data-dir" && explicit },
    getName: () => name,
    setName: value => { name = value; },
    getPath: key => paths[key],
    setPath: (key, value) => { assert.ok(key in paths); paths[key] = value; },
  };
  return { app, appData, legacyProfile, initialProfile };
}

test("the renamed installed app retains the existing desktop profile and preferences", t => {
  const { app, appData, legacyProfile } = fixture(t);
  configureProductIdentity(app);
  assert.equal(app.getName(), "mymausbot");
  assert.equal(app.getPath("userData"), legacyProfile);
  assert.equal(app.getPath("sessionData"), legacyProfile);
  assert.deepEqual(JSON.parse(readFileSync(path.join(legacyProfile, "desktop-prefs.json"), "utf8")), { credentialMode: "session", language: "zh" });
  assert.equal(existsSync(path.join(appData, "mymausbot")), false);
});

test("an explicitly separated browser session directory is preserved", t => {
  const { app, legacyProfile } = fixture(t, { customSession: true });
  const sessionData = app.getPath("sessionData");
  configureProductIdentity(app);
  assert.equal(app.getPath("userData"), legacyProfile);
  assert.equal(app.getPath("sessionData"), sessionData);
});

test("an existing profile named after the internal package stays accessible", t => {
  const { app, legacyProfile } = fixture(t, { legacyName: "openmausbot" });
  configureProductIdentity(app);
  const actual = statSync(app.getPath("userData"));
  const expected = statSync(legacyProfile);
  assert.deepEqual([actual.dev, actual.ino], [expected.dev, expected.ino]);
  assert.equal(app.getPath("sessionData"), app.getPath("userData"));
  assert.equal(JSON.parse(readFileSync(path.join(app.getPath("userData"), "desktop-prefs.json"), "utf8")).credentialMode, "session");
});

test("a fresh installation uses the same stable desktop profile location", t => {
  const { app, legacyProfile, initialProfile } = fixture(t, { legacy: false });
  configureProductIdentity(app);
  assert.equal(app.getPath("userData"), legacyProfile);
  assert.equal(existsSync(initialProfile), false);
  assert.equal(existsSync(legacyProfile), true);
});

test("an empty profile prepared by Electron does not hide the existing desktop profile", t => {
  const { app, initialProfile, legacyProfile } = fixture(t);
  mkdirSync(initialProfile, { recursive: true });
  configureProductIdentity(app);
  assert.equal(app.getPath("userData"), legacyProfile);
  assert.equal(JSON.parse(readFileSync(path.join(legacyProfile, "desktop-prefs.json"), "utf8")).language, "zh");
});

for (const options of [{ custom: true }, { explicit: true }, { packaged: false }]) {
  test(`an isolated or development profile never adopts the installed profile: ${JSON.stringify(options)}`, t => {
    const { app, initialProfile } = fixture(t, options);
    configureProductIdentity(app);
    assert.equal(app.getName(), "mymausbot");
    assert.equal(app.getPath("userData"), initialProfile);
    assert.equal(existsSync(path.join(initialProfile, "desktop-prefs.json")), false);
  });
}
