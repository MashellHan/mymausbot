const startBlock = /^<!-- mausbot-qa:([a-f\d]{24}) -->\s+<!-- mausbot-qa:start -->/gm;
const endBlock = /^<!-- mausbot-qa:end -->\r?$/m;
const keyMarker = /^<!-- mausbot-qa:([a-f\d]{24}) -->\r?$/gm;
const stateLine = /<!-- mausbot-qa-state ([^\r\n]+) -->/g;

export function generatedSections(body) {
  const starts = [...body.matchAll(startBlock)];
  return starts.map((start, index) => {
    const limit = starts[index + 1]?.index ?? body.length;
    const text = body.slice(start.index, limit);
    const end = endBlock.exec(text);
    return { key: start[1], start: start.index, text: end ? text.slice(0, end.index + end[0].length) : text, complete: Boolean(end) };
  });
}

function parseState(raw, key) {
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  if (state?.key !== key) return null;
  for (const scope of [state.caseKeys, state.verificationJobs]) {
    if (scope !== undefined && (!Array.isArray(scope) || !scope.every((item) => typeof item === "string" && item.length))) return null;
  }
  return state;
}

export function issueKey(body, confirmedGroupParent = false) {
  if (typeof body !== "string") return null;
  const starts = [...body.matchAll(startBlock)];
  const markers = starts.length ? starts : [...body.matchAll(keyMarker)];
  const keys = new Set(markers.map((match) => match[1]));
  if (keys.size !== 1) return null;
  const key = markers[0][1];
  if (starts.length || confirmedGroupParent) return key;
  return stateRecord(body, key)?.state.key ?? null;
}

export function stateRecord(body, key) {
  if (typeof body !== "string") return null;
  const sections = generatedSections(body);
  const blocks = key ? sections.filter((block) => block.key === key) : sections;
  if (sections.length && (blocks.length !== 1 || !blocks[0].complete)) return null;
  const block = blocks[0];
  const text = block?.text ?? body;
  const markers = [...text.matchAll(keyMarker)], lines = [...text.matchAll(stateLine)];
  if (markers.length !== 1 || lines.length !== 1 || (key && key !== markers[0][1])) return null;
  const [line] = lines;
  const state = parseState(line[1], markers[0][1]);
  if (!state) return null;
  const controls = body.match(/<!-- mausbot-qa:(?:[a-f\d]{24}|start|end) -->|<!-- mausbot-qa-state /g);
  const canonical = Boolean(block && controls?.length === 4 && text.slice(0, line.index).trimEnd().endsWith("<!-- mausbot-qa:start -->"));
  return { state, canonical, start: (block?.start ?? 0) + line.index, length: line[0].length };
}

export function withState(body, record, state) {
  return body.slice(0, record.start) + `<!-- mausbot-qa-state ${JSON.stringify(state)} -->` + body.slice(record.start + record.length);
}

export function previousCoverage(body, key) {
  const cases = new Set(), jobs = new Set();
  const blocks = generatedSections(body).filter((block) => block.key === key);
  let unknown = !blocks.length && body.includes("<!-- mausbot-qa-state ");
  for (const block of blocks) {
    const lines = [...block.text.matchAll(stateLine)];
    if (!block.complete || lines.length !== 1) unknown = true;
    for (const line of lines) {
      const state = parseState(line[1], key);
      if (!state || state.coverageUnknown) unknown = true;
      for (const item of state?.caseKeys ?? []) cases.add(item);
      for (const job of state?.verificationJobs ?? []) jobs.add(job);
    }
  }
  return { caseKeys: [...cases], verificationJobs: [...jobs], coverageUnknown: unknown, hasRecords: blocks.length > 0 };
}
