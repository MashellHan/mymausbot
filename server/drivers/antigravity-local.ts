import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { augmentedPath } from "../env-path.ts";

export interface LocalAntigravityConfig {
  configured: boolean;
  baseUrl?: string;
  modelContextWindows: Map<string, number>;
}

export interface LocalAntigravityCli {
  executablePath: string;
  baseUrl?: string;
  modelContextWindows: Map<string, number>;
}

interface ParsedGeminiDotEnv {
  hasApiKey: boolean;
  googleGeminiBaseUrl?: string;
}

const MODEL_ID_PATTERN = /\/models\/([^/?#]+)$/u;
const LOOPBACK_GEMINI_API_PATTERN = /^gemini-api:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?\//iu;

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === "\"" || quote === "'") && trimmed.at(-1) === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Security: never retain or return GEMINI_API_KEY values; only record non-empty presence. */
function parseGeminiDotEnv(source: string): ParsedGeminiDotEnv {
  let hasApiKey = false;
  let googleGeminiBaseUrl: string | undefined;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === "GEMINI_API_KEY") {
      hasApiKey = unquoteEnvValue(rawValue!).trim().length > 0;
    } else if (key === "GOOGLE_GEMINI_BASE_URL") {
      googleGeminiBaseUrl = unquoteEnvValue(rawValue!).trim() || undefined;
    }
  }
  return { hasApiKey, googleGeminiBaseUrl };
}

async function readJsonBestEffort(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSearchPath(env: NodeJS.ProcessEnv): string {
  const pathValue = process.platform === "win32"
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  return pathValue ?? augmentedPath();
}

export async function readLocalAntigravityConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAntigravityConfig> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const geminiDir = join(home, ".gemini");

  let dotEnv: ParsedGeminiDotEnv = { hasApiKey: false };
  try {
    dotEnv = parseGeminiDotEnv(await readFile(join(geminiDir, ".env"), "utf8"));
  } catch {}

  const hasApiKey = Boolean(env.GEMINI_API_KEY?.trim() || dotEnv.hasApiKey);
  let baseUrl = env.AGY_RAVEN_BASE_URL?.trim()
    || env.GOOGLE_GEMINI_BASE_URL?.trim()
    || dotEnv.googleGeminiBaseUrl
    || undefined;

  const settings = await readJsonBestEffort(join(geminiDir, "settings.json"));
  const security = settings?.security;
  const auth = security && typeof security === "object" && !Array.isArray(security)
    ? (security as Record<string, unknown>).auth
    : undefined;
  const authType = auth && typeof auth === "object" && !Array.isArray(auth)
    && typeof (auth as Record<string, unknown>).selectedType === "string"
    ? ((auth as Record<string, unknown>).selectedType as string).trim()
    : undefined;

  const modelContextWindows = new Map<string, number>();
  const cliSettings = await readJsonBestEffort(join(geminiDir, "antigravity-cli", "settings.json"));
  const customModelsConfig = cliSettings?.customModelsConfig;
  const customModels = customModelsConfig && typeof customModelsConfig === "object" && !Array.isArray(customModelsConfig)
    ? (customModelsConfig as Record<string, unknown>).customModels
    : undefined;

  if (customModels && typeof customModels === "object" && !Array.isArray(customModels)) {
    for (const entry of Object.values(customModels as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const modelName = typeof record.modelName === "string" ? record.modelName.trim() : "";
      if (!modelName) continue;

      const modelMatch = MODEL_ID_PATTERN.exec(modelName);
      const rawMaxTokens = record.maxTokens;
      if (modelMatch && typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0) {
        const tokens = Math.floor(rawMaxTokens);
        if (tokens > 0) {
          const previous = modelContextWindows.get(modelMatch[1]!);
          if (previous === undefined || tokens > previous) {
            modelContextWindows.set(modelMatch[1]!, tokens);
          }
        }
      }

      if (!baseUrl) {
        const loopbackMatch = LOOPBACK_GEMINI_API_PATTERN.exec(modelName);
        if (loopbackMatch) {
          baseUrl = `http://${loopbackMatch[1]}${loopbackMatch[2] ? `:${loopbackMatch[2]}` : ""}`;
        }
      }
    }
  }

  const configured = hasApiKey && (Boolean(baseUrl) || authType === "gemini-api-key");
  return { configured, baseUrl, modelContextWindows };
}

export async function resolveLocalAntigravityCli(
  env: NodeJS.ProcessEnv = process.env,
  preferredPath?: string,
): Promise<LocalAntigravityCli | null> {
  const config = await readLocalAntigravityConfig(env);
  if (!config.configured) return null;

  const preferred = preferredPath?.trim();
  if (preferred && (preferred.includes("/") || preferred.includes("\\"))) {
    const candidate = resolve(preferred);
    if (await isExecutableFile(candidate)) {
      return {
        executablePath: candidate,
        baseUrl: config.baseUrl,
        modelContextWindows: config.modelContextWindows,
      };
    }
  }

  const binaryNames = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  const directories = resolveSearchPath(env)
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);

  for (const directory of directories) {
    for (const name of binaryNames) {
      const candidate = resolve(directory, name);
      if (await isExecutableFile(candidate)) {
        return {
          executablePath: candidate,
          baseUrl: config.baseUrl,
          modelContextWindows: config.modelContextWindows,
        };
      }
    }
  }
  return null;
}
