export function productNameMismatch(errors) {
  if (!errors?.length) return null;
  const normalize = (value) => value.replace(/\b(?:OpenMausBot|MausBot)\b/g, "mymausbot");
  for (const error of errors) {
    const { actual, expected } = error;
    if (error.name !== "AssertionError" || typeof actual !== "string" || typeof expected !== "string" || actual === expected || /not to/.test(error.message ?? "")) return null;
    if (normalize(actual) === normalize(expected)) continue;
    if (/ to (?:contain|include) /.test(error.message ?? "") && !/not to/.test(error.message)
      && !actual.includes(expected) && normalize(actual).includes(normalize(expected))) continue;
    return null;
  }
  return { from: "MausBot", to: "mymausbot" };
}
