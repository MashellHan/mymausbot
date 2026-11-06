export function parseCompleteJsonLines<T>(text: string): T[] {
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}
