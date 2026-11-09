export function combineTextFindings(findings, issues, byKey, signature, stateOf) {
  const owners = new Map();
  for (const issue of issues) {
    const state = stateOf(issue);
    for (const key of state?.caseKeys ?? []) {
      if (owners.has(key)) throw new Error(`Ambiguous QA text case ${key}`);
      owners.set(key, state);
    }
  }
  const combined = new Map();
  for (const finding of findings) {
    const owner = owners.get(finding.key);
    const change = owner?.textChange ?? finding.textChange;
    if (!change || byKey.has(finding.key) || issues.some((issue) => issue.body?.includes(`<!-- mausbot-qa:${finding.key} -->`))) {
      combined.set(finding.key, finding);
      continue;
    }
    const key = owner?.key ?? signature(`text:${change.from}\0${change.to}`, "shared");
    if (!combined.has(key)) combined.set(key, { ...finding, key, contract: `Product name mismatch: ${change.from} / ${change.to}`,
      platform: "shared", file: undefined, textChange: change, cases: [] });
    combined.get(key).cases.push(finding);
    combined.get(key).retries = Math.max(combined.get(key).retries, finding.retries);
  }
  return [...combined.values()];
}

export function textCaseEvidence(finding, report, previous, sanitize) {
  if (!finding.cases) return "";
  const block = previous.match(/<!-- mausbot-qa-cases:start -->\n([\s\S]*?)\n<!-- mausbot-qa-cases:end -->/)?.[1] ?? "";
  const rows = new Map(block.split("\n").filter(Boolean).map((line) => [line.match(/^- `([a-f\d]{24})`/)?.[1], line]));
  for (const entry of finding.cases) {
    if (!rows.has(entry.key)) rows.set(entry.key, `- \`${entry.key}\` · \`${sanitize(entry.platform)}\` · ${sanitize(entry.contract).replaceAll("`", "'").replace(/[\r\n]/g, " ")} ([first report](${report.url}))`);
  }
  return ["Affected cases (each key retains its file, test and platform; see the linked report for assertions):",
    "<!-- mausbot-qa-cases:start -->", ...rows.values(), "<!-- mausbot-qa-cases:end -->"].join("\n");
}
