import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const VERSION = "43.7.9";
const MIRROR = "https://npmmirror.com/mirrors/electron/";
// Electron's v43.7.9 release asset digests, independently matched to its locked npm package on 2026-11-09.
const DIGESTS = {
  "darwin-arm64": "dcf13726bbf45646c968bb67f48d24ecfb941af1b3c01217f84edaf50fee632a",
  "linux-x64": "684c0beebab080d079c9ae26ba1f2e7af97c95e27772e8ded45ff02f25db17ec",
  "win32-x64": "92171b4a51c8547e48c8cfeca63c655841994031aabf79db80658319d95fafe5",
};

export function electronRecovery(version, platform, arch, checksums) {
  const digest = version === VERSION ? DIGESTS[`${platform}-${arch}`] : undefined;
  if (!digest) return null;
  const archive = `electron-v${version}-${platform}-${arch}.zip`;
  if (checksums[archive] !== digest) throw new Error(`The locked Electron checksum differs from its original release: ${archive}`);
  return { archive, digest, platform, arch, mirror: MIRROR, directory: "{{ version }}" };
}

export function electronInstallEnvironment(recovery, inherited = process.env) {
  const env = { ...inherited };
  const controlled = new Set([
    "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums",
    "electron_custom_version", "npm_config_electron_customversion", "npm_config_electron_custom_version",
    "npm_package_config_electron_customversion", "npm_package_config_electron_custom_version",
    "electron_install_platform", "electron_install_arch", "npm_config_platform", "npm_config_arch",
    "electron_mirror", "electron_custom_dir", "npm_config_electron_mirror", "npm_config_electron_customdir",
  ]);
  for (const name of Object.keys(env)) {
    if (controlled.has(name.toLowerCase())) delete env[name];
  }
  return {
    ...env,
    ELECTRON_INSTALL_PLATFORM: recovery.platform,
    ELECTRON_INSTALL_ARCH: recovery.arch,
    npm_config_electron_mirror: recovery.mirror,
    npm_config_electron_customdir: recovery.directory,
    ELECTRON_MIRROR: recovery.mirror,
    ELECTRON_CUSTOM_DIR: recovery.directory,
  };
}

export function ensureElectronRuntime() {
  let originalError;
  try { return require("electron"); }
  catch (error) {
    if (!String(error).includes("Electron failed to install correctly")) throw error;
    originalError = error;
  }
  const entry = realpathSync(require.resolve("electron"));
  const packageDir = dirname(entry);
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const checksums = JSON.parse(readFileSync(join(packageDir, "checksums.json"), "utf8"));
  const recovery = electronRecovery(version, process.platform, process.arch, checksums);
  if (!recovery) throw originalError;
  const installed = spawnSync(process.execPath, [join(packageDir, "install.js")], {
    env: electronInstallEnvironment(recovery),
    stdio: "inherit",
    timeout: 180_000,
  });
  if (installed.error || installed.status !== 0) throw new Error(`Could not restore the original ${recovery.archive} from the verified Electron mirror`, { cause: installed.error ?? originalError });
  return require("electron");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Electron runtime ready: ${ensureElectronRuntime()}`);
}
