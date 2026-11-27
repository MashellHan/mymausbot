// Optional zero-server local embeddings hook (Int8 quantized cosine similarity + RRF fusion).
export interface MemoryEmbeddingProvider {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export function quantizeInt8(vec: Float32Array): Int8Array {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const abs = Math.abs(vec[i]!);
    if (abs > maxAbs) maxAbs = abs;
  }
  const out = new Int8Array(vec.length);
  if (maxAbs === 0) return out;
  const scale = 127 / maxAbs;
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = Math.max(-127, Math.min(127, Math.round(vec[i]! * scale)));
  }
  return out;
}

export function cosineInt8(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function reciprocalRankFusion<T extends string>(rankings: ReadonlyArray<readonly T[]>, k = 60): Map<T, number> {
  const scores = new Map<T, number>();
  for (const list of rankings) {
    for (let i = 0; i < list.length; i += 1) {
      const id = list[i]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}
