// MEMORY.md entry grammar: `- YYYY-MM-DD · from <source> · text[ · from YYYY-MM-DD][ · until YYYY-MM-DD]`, struck through when superseded.
import { createHash } from "node:crypto";

export const UNTIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED = /^(- (\d{4}-\d{2}-\d{2}) · (?:from [^·\n]* · )?)(.*)$/;
const VALID_FROM_MARK = / · from (\d{4}-\d{2}-\d{2})(?= · |$)/;
const UNTIL_MARK = / · until (\d{4}-\d{2}-\d{2})(?= · |$)/;
const SUPERSEDED_MARK = / · superseded (\d{4}-\d{2}-\d{2})(?: by ([A-Za-z0-9#._:-]{1,48}))?(?= · |$)/;
const TRAILING_MARKS = /(?: · (?:updated|confirmed|from|until|expired|moved) \d{4}-\d{2}-\d{2}| · superseded \d{4}-\d{2}-\d{2}(?: by [A-Za-z0-9#._:-]{1,48})?)+$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** A safety or health fact always loads: neither organize nor the size rule moves one out of MEMORY.md. */
const ALWAYS_CORE = /\b(?:allerg\w*|anaphyla\w*|intoleran\w*|vegetarian|vegan|halal|kosher|gluten|lactose|diet\w*|diabet\w*|asthma\w*|epilep\w*|pregnan\w*|medicat\w*|medicine|medical|disabilit\w*|wheelchair|blind|deaf|health)\b/i;

export function alwaysCore(body: string): boolean {
  return ALWAYS_CORE.test(body);
}

export interface MemoryEntryLine {
  id: string;
  line: number;
  end: number;
  raw: string;
  prefix: string;
  body: string;
  date: string;
  validFrom: string;
  until: string | null;
  supersededAt?: string;
  supersededBy?: string;
  struck: boolean;
}

export function isMemoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !UNTIL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validFromMark(validFrom: string | undefined): string {
  return validFrom ? ` · from ${validFrom}` : "";
}

export function untilMark(until: string | undefined): string {
  return until ? ` · until ${until}` : "";
}

export function memoryEntryId(date: string, body: string, path = ""): string {
  return createHash("sha256").update(`${path}:${date}:${factIdentity(body)}`).digest("hex").slice(0, 10);
}

const togglesFence = (line: string) => (line.match(/```/g)?.length ?? 0) % 2 === 1;

/** Undated hand-written lines are not entries and upkeep never touches them. */
export function parseMemoryEntries(text: string, path = ""): MemoryEntryLine[] {
  const out: MemoryEntryLine[] = [];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  for (let line = 0; line < lines.length;) {
    const raw = lines[line];
    const m = DATED.exec(raw);
    if (!m) {
      line += 1;
      continue;
    }
    let open = togglesFence(raw);
    let end = line + 1;
    for (let next = line + 1; next < lines.length && !DATED.test(lines[next]); next += 1) {
      if (!open && !/^[ \t]/.test(lines[next]) && !lines[next].startsWith("```")) break;
      if (togglesFence(lines[next])) open = !open;
      if (!open) end = next + 1;
    }
    const rest = m[3];
    const struck = rest.startsWith("~~");
    const validFromMatch = VALID_FROM_MARK.exec(rest)?.[1];
    const validFrom = validFromMatch && isMemoryDate(validFromMatch) ? validFromMatch : m[2];
    const until = UNTIL_MARK.exec(rest)?.[1] ?? null;
    const superseded = SUPERSEDED_MARK.exec(rest);
    const body = rest.replace(TRAILING_MARKS, "").replace(/^~~/, "").replace(/~~$/, "").trim();
    const id = memoryEntryId(m[2], body, path);
    out.push({
      id,
      line,
      end,
      raw,
      prefix: m[1],
      body,
      date: m[2],
      validFrom,
      until,
      ...(superseded?.[1] ? { supersededAt: superseded[1] } : {}),
      ...(superseded?.[2] ? { supersededBy: superseded[2] } : {}),
      struck,
    });
    line = end;
  }
  return out;
}

export function isFuture(entry: Pick<MemoryEntryLine, "validFrom" | "struck">, today: string): boolean {
  return !entry.struck && entry.validFrom > today;
}

export function isExpired(entry: Pick<MemoryEntryLine, "until" | "struck">, today: string): boolean {
  return !entry.struck && entry.until !== null && entry.until < today;
}

export function isActiveEntry(entry: Pick<MemoryEntryLine, "validFrom" | "until" | "struck">, today: string): boolean {
  return !entry.struck && entry.validFrom <= today && (entry.until === null || entry.until >= today);
}

export function withoutExpired(text: string, today: string): { text: string; hidden: number } {
  const expired = parseMemoryEntries(text).filter((e) => isExpired(e, today));
  if (!expired.length) return { text, hidden: 0 };
  const dropped = new Set<number>();
  for (const entry of expired) for (let line = entry.line; line < entry.end; line++) dropped.add(line);
  return { text: text.split("\n").filter((_, index) => !dropped.has(index)).join("\n"), hidden: expired.length };
}

/** Deliberately narrow: `-10` and `10`, `C++` and `C`, `API_KEY` and `api_key` stay different facts. */
export function factIdentity(text: string): string {
  return text
    .normalize("NFC")
    .replace(BULLET, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .trim();
}

export function lineFactIdentity(line: string): string {
  const entry = parseMemoryEntries(line)[0];
  if (entry) return entry.struck ? "" : factIdentity(entry.body);
  return factIdentity(line.replace(/~~/g, ""));
}

export function notebookIdentities(text: string): Set<string> {
  return new Set(text.split("\n").map(lineFactIdentity).filter(Boolean));
}

export function withoutSuperseded(text: string): string {
  const dropped = new Set<number>();
  for (const entry of parseMemoryEntries(text)) {
    if (entry.struck) for (let line = entry.line; line < entry.end; line++) dropped.add(line);
  }
  return text.split("\n").filter((_, index) => !dropped.has(index)).join("\n");
}

/** Case, width, curly quotes and spacing aside, so a passage matches however the note was typed. */
export function foldForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
}

/** Whether a note mentions `passage` as whole words ("IST" is not in "dentist"); null for a passage too short to name anything. */
export function passageMatcher(passage: string): ((text: string) => boolean) | null {
  const folded = foldForMatch(passage);
  if ((folded.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
  return (text) => pattern.test(foldForMatch(text));
}
