export const generatedBlock = /^<!-- mausbot-qa:([a-f\d]{24}) -->\s+<!-- mausbot-qa:start -->[\s\S]*?^<!-- mausbot-qa:end -->\r?$/gm;

export function stateRecord(body = "", key) {
  if (typeof body !== "string") return null;
  const blocks = [...body.matchAll(generatedBlock)].filter((block) => !key || block[1] === key);
  if (blocks.length > 1 || (!blocks.length && body.includes("<!-- mausbot-qa:start -->"))) return null;
  const block = blocks[0];
  const section = block?.[0] ?? body;
  const markers = [...section.matchAll(/<!-- mausbot-qa:([a-f\d]{24}) -->/g)];
  const lines = [...section.matchAll(/<!-- mausbot-qa-state ([^\r\n]+) -->/g)];
  if (markers.length !== 1 || lines.length !== 1) return null;
  const [line] = lines;
  let state;
  try { state = JSON.parse(line[1]); } catch { return null; }
  if (!state?.key || state.key !== markers[0][1] || (key && key !== state.key)) return null;
  const controls = body.match(/<!-- mausbot-qa:(?:[a-f\d]{24}|start|end) -->|<!-- mausbot-qa-state /g);
  const canonical = Boolean(block && controls?.length === 4
    && section.slice(0, line.index).trimEnd().endsWith("<!-- mausbot-qa:start -->"));
  return { state, canonical, start: (block?.index ?? 0) + line.index, length: line[0].length };
}

export function withState(body, record, state) {
  return body.slice(0, record.start) + `<!-- mausbot-qa-state ${JSON.stringify(state)} -->` + body.slice(record.start + record.length);
}
