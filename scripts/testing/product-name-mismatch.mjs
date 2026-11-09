export function productNameMismatch(errors) {
  if (!errors?.length) return null;
  const normalize = (value) => value.replace(/\b(?:OpenMausBot|MausBot)\b/g, "mymausbot");
  for (const error of errors) {
    const { actual, expected } = error;
    // Vitest 4.1.11 pretty-prints non-string values before this hook, hiding deep differences.
    const operation = error.message?.match(/^expected (['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1 (to (?:be|(?:(?:deeply|strictly) )?equal|contain|include)) (['"`])(?:\\[\s\S]|(?!\3)[^\\])*\3(?: \/\/ Object\.is equality)?$/)?.[2];
    if (!operation || error.name !== "AssertionError" || typeof actual !== "string" || typeof expected !== "string" || actual === expected) return null;
    if (normalize(actual) === normalize(expected)) continue;
    if (["to contain", "to include"].includes(operation)
      && !actual.includes(expected) && normalize(actual).includes(normalize(expected))) continue;
    return null;
  }
  return { from: "MausBot", to: "mymausbot" };
}
