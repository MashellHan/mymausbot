import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { configureLinuxDesktop, linuxDisablesGpu, SOFTWARE_RENDERING_ARG } from "./linux-gpu.mjs";

const only = (...paths) => (p) => paths.includes(p);

test("NVIDIA keeps software rendering", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/proc/driver/nvidia/version") }), true);
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/nvidia") }), true);
});

test("Intel, AMD and other drivers use the GPU", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only() }), false);
});

test("OMB_LINUX_GPU overrides detection either way", () => {
  assert.equal(linuxDisablesGpu({ env: { OMB_LINUX_GPU: "off" }, exists: only() }), true);
  assert.equal(linuxDisablesGpu({ env: { OMB_LINUX_GPU: "on" }, exists: only("/sys/module/nvidia") }), false);
});

test("configures Linux startup identity and GPU without affecting other platforms", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const calls = [];
    configureLinuxDesktop({ disableHardwareAcceleration: () => calls.push("software"), setDesktopName: (name) => calls.push(name) },
      { platform, env: {}, exists: only("/sys/module/nvidia") });
    assert.deepEqual(calls, platform === "linux" ? ["software", "com.openmausbot.app.desktop"] : []);
  }
});

test("a launch that explicitly disables the GPU also marks Linux software rendering", () => {
  const calls = [];
  const software = configureLinuxDesktop({ commandLine: { hasSwitch: (name) => name === "disable-gpu" },
    disableHardwareAcceleration: () => calls.push("software"), setDesktopName: (name) => calls.push(name) },
  { platform: "linux", env: { OMB_LINUX_GPU: "on" }, exists: only() });
  assert.equal(software, true);
  assert.deepEqual(calls, ["software", "com.openmausbot.app.desktop"]);
});

test("the main window tells its page when it renders without a GPU, so pop-ups drop their blur", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(main, /linuxSoftwareRendering \? \[SOFTWARE_RENDERING_ARG\] : \[\]/);
  assert.equal(SOFTWARE_RENDERING_ARG, "--omb-software-rendering=1");
  assert.match(preload, /softwareRendering: process\.argv\.includes\("--omb-software-rendering=1"\)/);
  assert.match(main, /const linuxSoftwareRendering = configureLinuxDesktop\(app\)/);
  // My Cloud's page is remote: it needs the flag too.
  assert.match(preload, /const REMOTE_SAFE = new Set\(\[[^\]]*"softwareRendering"/);
});
