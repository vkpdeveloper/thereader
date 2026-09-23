import 'dart:math';

/// How a book is split into byte ranges for parallel download.
///
/// Every range is one Worker invocation plus R2 reads on a free plan, so the
/// plan targets a fixed request budget per book instead of a fixed segment
/// size: a 181 MiB edition becomes 32 segments plus one ZIP tail request.
class SegmentPolicy {
  const SegmentPolicy({
    this.connections = defaultConnections,
    this.demandConnections = 1,
    this.targetSegments = 32,
    this.minSegment = 4 * 1024 * 1024,
    this.maxSegment = 16 * 1024 * 1024,
    this.singleRequestLimit = 4 * 1024 * 1024,
    this.demandSplitDistance = 1024 * 1024,
    this.maxAttempts = 4,
    this.retryDelay = const Duration(milliseconds: 500),
  });

  static const defaultConnections = 4;

  /// Bytes are written and served to the reader in chunks of this size, and
  /// every segment boundary is a multiple of it.
  static const alignment = 64 * 1024;

  /// Largest ZIP end-of-central-directory search window (22 + 65535 bytes).
  static const zipTailWindow = 65557;

  /// Background workers pulling segments from the shared queue.
  final int connections;

  /// Extra connections reserved for bytes the reader is waiting on.
  final int demandConnections;
  final int targetSegments;
  final int minSegment;
  final int maxSegment;

  /// Books up to this size are fetched with one request.
  final int singleRequestLimit;

  /// A reader demand further than this from where a segment would start (or
  /// where its worker currently is) splits the segment instead of waiting.
  final int demandSplitDistance;
  final int maxAttempts;

  /// First retry delay; doubles on each further attempt.
  final Duration retryDelay;

  int segmentSizeFor(int bytes) {
    final even = (bytes + targetSegments - 1) ~/ targetSegments;
    return _alignUp(min(maxSegment, max(minSegment, even)));
  }

  /// Ranges as `[start, end)` pairs covering `[0, fileSize)` in the order
  /// they should be fetched: the ZIP tail first, then front to back.
  List<(int, int)> plan(int fileSize) {
    if (fileSize <= 0) throw ArgumentError.value(fileSize, 'fileSize');
    if (fileSize <= singleRequestLimit) return [(0, fileSize)];
    final tailStart = max(0, fileSize - zipTailWindow) ~/ alignment * alignment;
    final size = segmentSizeFor(tailStart);
    return [
      (tailStart, fileSize),
      for (var start = 0; start < tailStart; start += size)
        (start, min(start + size, tailStart)),
    ];
  }

  static int _alignUp(int value) =>
      (value + alignment - 1) ~/ alignment * alignment;
}
