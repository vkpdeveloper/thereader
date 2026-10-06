/**
 * The Zyte article-extraction-benchmark metric, ported line for line from its
 * evaluate.py: per-document TP/FP/FN over 4-token shingles (normalized to sum
 * to 1), precision and recall averaged over documents, F1 from the averages,
 * accuracy as exact token-sequence equality, bootstrap std over documents.
 */

export type TpFpFn = [number, number, number];

/** Python's Unicode `\w+`: letters, numbers and underscore (combining marks split tokens). */
const TOKEN = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string | null | undefined): string[] {
  return (text ?? '').match(TOKEN) ?? [];
}

function shingles(text: string, n: number): Map<string, number> {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < Math.max(1, tokens.length - n + 1); i++) {
    const shingle = tokens.slice(i, i + n);
    if (shingle.length === 0) continue;
    const key = shingle.join('\u0001');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function shingleMatch(truth: string, pred: string, n = 4): TpFpFn {
  const t = shingles(truth, n);
  const p = shingles(pred, n);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const key of new Set([...t.keys(), ...p.keys()])) {
    const tc = t.get(key) ?? 0;
    const pc = p.get(key) ?? 0;
    tp += Math.min(tc, pc);
    fp += Math.max(0, pc - tc);
    fn += Math.max(0, tc - pc);
  }
  const sum = tp + fp + fn;
  return sum > 0 ? [tp / sum, fp / sum, fn / sum] : [tp, fp, fn];
}

export function precisionScore([tp, fp, fn]: TpFpFn): number {
  if (fp === 0 && fn === 0) return 1;
  if (tp === 0 && fp === 0) return 0;
  return tp / (tp + fp);
}

export function recallScore([tp, fp, fn]: TpFpFn): number {
  if (fp === 0 && fn === 0) return 1;
  if (tp === 0 && fn === 0) return 0;
  return tp / (tp + fn);
}

export function f1Score(row: TpFpFn): number {
  const p = precisionScore(row);
  const r = recallScore(row);
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

export function accuracyScore(truth: string, pred: string): number {
  const a = tokenize(truth);
  const b = tokenize(pred);
  return a.length === b.length && a.every((token, i) => token === b[i]) ? 1 : 0;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

export function aggregate(rows: TpFpFn[]): { precision: number; recall: number; f1: number } {
  const precision = mean(rows.filter(([tp, fp]) => tp + fp > 0).map(precisionScore));
  const recall = mean(rows.filter(([tp, , fn]) => tp + fn > 0).map(recallScore));
  return { precision, recall, f1: (2 * precision * recall) / (precision + recall) };
}

export interface ZyteMetrics {
  f1: number;
  precision: number;
  recall: number;
  accuracy: number;
  f1_std: number;
  precision_std: number;
  recall_std: number;
  accuracy_std: number;
  /** 95% bootstrap percentile interval of F1. */
  f1_ci: [number, number];
}

/** Seeded PRNG so bootstrap numbers are reproducible run to run. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function evaluate(rows: TpFpFn[], accuracies: number[], bootstrap = 1000, seed = 1): ZyteMetrics {
  const base = aggregate(rows);
  const random = mulberry32(seed);
  const samples: Record<'f1' | 'precision' | 'recall' | 'accuracy', number[]> = { f1: [], precision: [], recall: [], accuracy: [] };
  for (let b = 0; b < bootstrap; b++) {
    const indices = rows.map(() => Math.floor(random() * rows.length));
    const metrics = aggregate(indices.map((i) => rows[i]));
    samples.f1.push(metrics.f1);
    samples.precision.push(metrics.precision);
    samples.recall.push(metrics.recall);
    samples.accuracy.push(mean(indices.map((i) => accuracies[i])));
  }
  const sorted = [...samples.f1].sort((a, b) => a - b);
  return {
    ...base,
    accuracy: mean(accuracies),
    f1_std: stdev(samples.f1),
    precision_std: stdev(samples.precision),
    recall_std: stdev(samples.recall),
    accuracy_std: stdev(samples.accuracy),
    f1_ci: [sorted[Math.floor(0.025 * bootstrap)], sorted[Math.ceil(0.975 * bootstrap) - 1]],
  };
}

/** Published numbers from the benchmark README (latest evaluation, commit pinned in zyte.ts). */
export const ZYTE_PUBLISHED: Record<string, { version: string; f1: number; precision: number; recall: number; accuracy: number }> = {
  readability_js: { version: '0.6.0', f1: 0.947, precision: 0.914, recall: 0.982, accuracy: 0.166 },
  trafilatura: { version: '2.0.0', f1: 0.958, precision: 0.938, recall: 0.978, accuracy: 0.293 },
  'html-text': { version: '0.7.0', f1: 0.665, precision: 0.5, recall: 0.994, accuracy: 0 },
};
