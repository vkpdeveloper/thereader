/**
 * How a book is split into byte ranges for parallel download. Ported from
 * mobile `SegmentPolicy` (apps/mobile/lib/data/download/segment_plan.dart).
 *
 * Every range is one Worker invocation plus R2 reads on a free plan, so the
 * plan targets a fixed request budget per book instead of a fixed segment
 * size: a 181 MiB edition becomes 32 segments plus one ZIP tail request.
 */

/** Bytes are stored and served in chunks of this size; every segment boundary is a multiple of it. */
export const SEGMENT_ALIGNMENT = 64 * 1024;

/** Largest ZIP end-of-central-directory search window (22 + 65535 bytes). */
export const ZIP_TAIL_WINDOW = 65557;

export interface SegmentPolicy {
  /** Background workers pulling segments from the shared queue. */
  connections: number;
  /** Extra connections reserved for bytes the reader is waiting on. */
  demandConnections: number;
  targetSegments: number;
  minSegment: number;
  maxSegment: number;
  /** Books up to this size are fetched with one request. */
  singleRequestLimit: number;
  /**
   * A reader demand further than this from where a segment would start (or
   * where its worker currently is) splits the segment instead of waiting.
   */
  demandSplitDistance: number;
  maxAttempts: number;
  /** First retry delay in ms; doubles on each further attempt. */
  retryDelayMs: number;
}

export const defaultSegmentPolicy: SegmentPolicy = {
  connections: 4,
  demandConnections: 1,
  targetSegments: 32,
  minSegment: 4 * 1024 * 1024,
  maxSegment: 16 * 1024 * 1024,
  singleRequestLimit: 4 * 1024 * 1024,
  demandSplitDistance: 1024 * 1024,
  maxAttempts: 4,
  retryDelayMs: 500,
};

const alignUp = (value: number): number => Math.ceil(value / SEGMENT_ALIGNMENT) * SEGMENT_ALIGNMENT;

export function segmentSizeFor(policy: SegmentPolicy, bytes: number): number {
  const even = Math.ceil(bytes / policy.targetSegments);
  return alignUp(Math.min(policy.maxSegment, Math.max(policy.minSegment, even)));
}

/**
 * Ranges as `[start, end)` pairs covering `[0, fileSize)` in the order they
 * should be fetched: the ZIP tail first, then front to back.
 */
export function planSegments(policy: SegmentPolicy, fileSize: number): Array<[number, number]> {
  if (!(fileSize > 0) || !Number.isSafeInteger(fileSize)) throw new RangeError(`Invalid file size ${fileSize}`);
  if (fileSize <= policy.singleRequestLimit) return [[0, fileSize]];
  const tailStart = Math.floor(Math.max(0, fileSize - ZIP_TAIL_WINDOW) / SEGMENT_ALIGNMENT) * SEGMENT_ALIGNMENT;
  const size = segmentSizeFor(policy, tailStart);
  const plan: Array<[number, number]> = [[tailStart, fileSize]];
  for (let start = 0; start < tailStart; start += size) plan.push([start, Math.min(start + size, tailStart)]);
  return plan;
}
