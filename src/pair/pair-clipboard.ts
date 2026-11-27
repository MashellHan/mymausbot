import { parsePwaPairHash } from "../lib/pwa-config";
import { readPairingInput } from "../../shared/pairing-code";

export interface ClipboardPairMatch {
  value: string;
  kind: "pwa-link" | "code" | "credential";
}

const URL_PAIR_RE = /https?:\/\/[^\s"'<>]*[#&]pair=[A-Za-z0-9_-]+/i;
const HASH_PAIR_RE = /(?:^|[\s"'<>])(#?pair=[A-Za-z0-9_-]+)/i;
const TOKEN_CANDIDATE_RE = /[A-Za-z0-9_-]{8,}/g;
const GROUPED_CODE_RE = /\b[A-Za-z0-9]{4}(?:[\s-][A-Za-z0-9]{4}){1,3}\b/g;

function normalizePwaHashCandidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/[),.;!?]+$/, "");
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (/[#&]pair=/.test(parsed.hash) && parsePwaPairHash(parsed.hash).ok) {
        return trimmed;
      }
    } catch {
      return null;
    }
    return null;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (/[#&]pair=/.test(normalized) && parsePwaPairHash(normalized).ok) {
    return normalized;
  }
  return null;
}

/**
 * Extracts a pairing link (`https://...#pair=...`), `#pair=...` fragment, pairing code (`XXXX-XXXX-XXXX`),
 * or pairing credential from clipboard text, including text wrapped inside a chat message.
 */
export function extractPairCandidateFromClipboard(raw: string): ClipboardPairMatch | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const directPwa = normalizePwaHashCandidate(trimmed);
  if (directPwa) return { value: directPwa, kind: "pwa-link" };

  const urlMatch = URL_PAIR_RE.exec(trimmed);
  if (urlMatch?.[0]) {
    const valid = normalizePwaHashCandidate(urlMatch[0]);
    if (valid) return { value: valid, kind: "pwa-link" };
  }

  const hashMatch = HASH_PAIR_RE.exec(trimmed);
  if (hashMatch?.[1]) {
    const valid = normalizePwaHashCandidate(hashMatch[1]);
    if (valid) return { value: valid, kind: "pwa-link" };
  }

  const directRead = readPairingInput(trimmed);
  if (directRead.kind === "code") return { value: trimmed, kind: "code" };
  if (directRead.kind === "credential") return { value: trimmed, kind: "credential" };

  for (const match of trimmed.matchAll(GROUPED_CODE_RE)) {
    const candidate = match[0];
    if (readPairingInput(candidate).kind === "code") {
      return { value: candidate, kind: "code" };
    }
  }

  for (const match of trimmed.matchAll(TOKEN_CANDIDATE_RE)) {
    const candidate = match[0];
    const read = readPairingInput(candidate);
    if (read.kind === "credential") return { value: candidate, kind: "credential" };
    if (read.kind === "code") return { value: candidate, kind: "code" };
  }

  return null;
}

export function canUseClipboardPaste(env: {
  clipboard?: { readText?: unknown } | null;
  isSecureContext?: boolean;
} = typeof window !== "undefined"
  ? {
      clipboard: typeof navigator !== "undefined" ? navigator.clipboard : null,
      isSecureContext: window.isSecureContext,
    }
  : {}): boolean {
  return Boolean(
    env.isSecureContext !== false &&
    env.clipboard &&
    typeof env.clipboard.readText === "function",
  );
}
