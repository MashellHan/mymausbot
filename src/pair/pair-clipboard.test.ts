import { describe, expect, it } from "vitest";
import { canUseClipboardPaste, extractPairCandidateFromClipboard } from "./pair-clipboard";

const SAMPLE_PAYLOAD = Buffer.from(
  JSON.stringify({ relayUrl: "https://relay.mxhan.com", credential: `omb_pair_${"k".repeat(43)}` }),
  "utf8",
).toString("base64url");

describe("pair-clipboard extraction", () => {
  it("extracts a bare PWA invite URL or hash fragment", () => {
    const url = `https://mausbot.mxhan.com/#pair=${SAMPLE_PAYLOAD}`;
    expect(extractPairCandidateFromClipboard(url)).toEqual({ value: url, kind: "pwa-link" });
    expect(extractPairCandidateFromClipboard(`#pair=${SAMPLE_PAYLOAD}`)).toEqual({
      value: `#pair=${SAMPLE_PAYLOAD}`,
      kind: "pwa-link",
    });
    expect(extractPairCandidateFromClipboard(`pair=${SAMPLE_PAYLOAD}`)).toEqual({
      value: `#pair=${SAMPLE_PAYLOAD}`,
      kind: "pwa-link",
    });
  });

  it("extracts a PWA invite URL embedded inside chat message prose", () => {
    const text = `Open my MausBot on your phone:\nhttps://mausbot.mxhan.com/#pair=${SAMPLE_PAYLOAD}. Thanks!`;
    const match = extractPairCandidateFromClipboard(text);
    expect(match?.kind).toBe("pwa-link");
    expect(match?.value).toBe(`https://mausbot.mxhan.com/#pair=${SAMPLE_PAYLOAD}`);
  });

  it("extracts hyphenated pairing codes and pairing credentials from prose", () => {
    expect(extractPairCandidateFromClipboard("Your code is 7KQ2-M9XD-H4TP (expires soon)")).toEqual({
      value: "7KQ2-M9XD-H4TP",
      kind: "code",
    });
    const cred = `omb_pair_${"z".repeat(43)}`;
    expect(extractPairCandidateFromClipboard(`token: ${cred}`)).toEqual({
      value: cred,
      kind: "credential",
    });
  });

  it("returns null for empty, random URLs, or invalid #pair payloads", () => {
    expect(extractPairCandidateFromClipboard("")).toBeNull();
    expect(extractPairCandidateFromClipboard("   \n  ")).toBeNull();
    expect(extractPairCandidateFromClipboard("https://example.com/hello")).toBeNull();
    expect(extractPairCandidateFromClipboard("https://mausbot.mxhan.com/#pair=invalid-base64")).toBeNull();
  });

  it("checks secure-context clipboard readText availability", () => {
    expect(canUseClipboardPaste({ clipboard: { readText: () => Promise.resolve("") }, isSecureContext: true })).toBe(true);
    expect(canUseClipboardPaste({ clipboard: { readText: () => Promise.resolve("") }, isSecureContext: false })).toBe(false);
    expect(canUseClipboardPaste({ clipboard: null, isSecureContext: true })).toBe(false);
  });
});
