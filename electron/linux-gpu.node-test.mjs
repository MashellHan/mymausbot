import assert from "node:assert/strict";
import test from "node:test";

import { configureLinuxDesktop, linuxDisablesGpu } from "./linux-gpu.mjs";

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
