/**
 * Deterministic Rollup manual chunk partitioning so immutable vendor code stays cached on phones
 * across frequent app UI deploys, while keeping async language/diagram/screen chunks untouched.
 */
const REACT_VENDOR_RE = /\/node_modules\/(?:react|react-dom|scheduler)\//;
const ICONS_VENDOR_RE = /\/node_modules\/lucide-react\//;
const MARKDOWN_VENDOR_RE =
  /\/node_modules\/(?:react-markdown|remark-[^/]+|rehype-[^/]+|unified|micromark[^/]*|mdast-[^/]+|hast-[^/]+|unist-[^/]+|vfile[^/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|bail|trough|is-plain-obj|devlop|zwitch|estree-util-[^/]+)\//;
const SHIKI_CORE_RE =
  /\/node_modules\/(?:@shikijs\/core|@shikijs\/engine-javascript|@shikijs\/types|shiki\/dist\/core)\//;

export function resolveManualChunk(rawId: string): string | undefined {
  const id = rawId.replace(/\\/g, "/");
  if (!id.includes("/node_modules/")) return undefined;

  // Keep per-language Shiki grammars, KaTeX, Mermaid, ELK, Cytoscape, and LiveKit in their own async chunks.
  if (
    id.includes("/shiki/langs/") ||
    id.includes("/@shikijs/langs/") ||
    id.includes("/mermaid") ||
    id.includes("/elkjs") ||
    id.includes("/cytoscape") ||
    id.includes("/livekit") ||
    id.includes("/katex")
  ) {
    return undefined;
  }

  if (REACT_VENDOR_RE.test(id)) return "vendor-react";
  if (ICONS_VENDOR_RE.test(id)) return "vendor-icons";
  if (MARKDOWN_VENDOR_RE.test(id)) return "vendor-markdown";
  if (SHIKI_CORE_RE.test(id)) return "vendor-shiki-core";
  return undefined;
}
