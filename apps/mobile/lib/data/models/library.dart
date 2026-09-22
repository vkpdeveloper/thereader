import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import 'book.dart';

enum DownloadStatus { none, queued, downloading, verifying, ready, failed }

@immutable
class DownloadState {
  const DownloadState({
    this.status = DownloadStatus.none,
    this.receivedBytes = 0,
    this.totalBytes,
    this.path,
    this.error,
  });

  final DownloadStatus status;
  final int receivedBytes;
  final int? totalBytes;

  /// Absolute path of the verified EPUB file (native) or an opaque key (web).
  final String? path;
  final String? error;

  bool get isReady => status == DownloadStatus.ready && path != null;
  bool get isActive =>
      status == DownloadStatus.queued ||
      status == DownloadStatus.downloading ||
      status == DownloadStatus.verifying;

  double? get fraction {
    final total = totalBytes;
    if (total == null || total <= 0) return null;
    return (receivedBytes / total).clamp(0, 1).toDouble();
  }

  DownloadState copyWith({
    DownloadStatus? status,
    int? receivedBytes,
    int? totalBytes,
    String? path,
    String? error,
    bool clearError = false,
  }) => DownloadState(
    status: status ?? this.status,
    receivedBytes: receivedBytes ?? this.receivedBytes,
    totalBytes: totalBytes ?? this.totalBytes,
    path: path ?? this.path,
    error: clearError ? null : (error ?? this.error),
  );

  Map<String, dynamic> toJson() => {
    'status': status.name,
    'receivedBytes': receivedBytes,
    'totalBytes': totalBytes,
    'path': path,
    'error': error,
  };

  factory DownloadState.fromJson(Map<String, dynamic> json) {
    var status = DownloadStatus.values.byName(json['status'] as String? ?? 'none');
    // In-flight downloads never survive a restart; report them as failed so the
    // user gets an honest, resumable state rather than a spinner forever.
    if (status == DownloadStatus.queued ||
        status == DownloadStatus.downloading ||
        status == DownloadStatus.verifying) {
      status = DownloadStatus.failed;
    }
    return DownloadState(
      status: status,
      receivedBytes: (json['receivedBytes'] as num?)?.toInt() ?? 0,
      totalBytes: (json['totalBytes'] as num?)?.toInt(),
      path: json['path'] as String?,
      error: status == DownloadStatus.failed
          ? (json['error'] as String? ?? 'Interrupted before it finished.')
          : json['error'] as String?,
    );
  }
}

/// Engine-agnostic reading position.
@immutable
class ReadingLocator {
  const ReadingLocator({
    required this.href,
    required this.progression,
    this.totalProgression,
    this.title,
    this.engine = 'dart',
    this.raw,
  });

  /// Spine item href (relative to the package document).
  final String href;

  /// 0..1 progression inside [href].
  final double progression;

  /// 0..1 progression in the whole publication, if known.
  final double? totalProgression;
  final String? title;

  /// Engine that produced this locator, so other engines can decide whether
  /// to trust [raw].
  final String engine;

  /// Engine-specific payload (e.g. a Readium locator JSON).
  final Map<String, dynamic>? raw;

  Map<String, dynamic> toJson() => {
    'href': href,
    'progression': progression,
    'totalProgression': totalProgression,
    'title': title,
    'engine': engine,
    'raw': raw,
  };

  factory ReadingLocator.fromJson(Map<String, dynamic> json) => ReadingLocator(
    href: json['href'] as String,
    progression: (json['progression'] as num?)?.toDouble() ?? 0,
    totalProgression: (json['totalProgression'] as num?)?.toDouble(),
    title: json['title'] as String?,
    engine: json['engine'] as String? ?? 'dart',
    raw: (json['raw'] as Map?)?.cast<String, dynamic>(),
  );
}

@immutable
class ReadingProgress {
  const ReadingProgress({required this.locator, required this.updatedAt});

  final ReadingLocator locator;
  final DateTime updatedAt;

  double get percent => (locator.totalProgression ?? 0).clamp(0, 1).toDouble();

  Map<String, dynamic> toJson() => {
    'locator': locator.toJson(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };

  factory ReadingProgress.fromJson(Map<String, dynamic> json) => ReadingProgress(
    locator: ReadingLocator.fromJson((json['locator'] as Map).cast<String, dynamic>()),
    updatedAt: DateTime.parse(json['updatedAt'] as String),
  );
}

/// A book the user has added to their library, with local download and
/// reading state. Persisted as JSON.
@immutable
class LibraryEntry {
  const LibraryEntry({
    required this.book,
    required this.source,
    required this.origin,
    required this.addedAt,
    this.download = const DownloadState(),
    this.progress,
    this.lastOpenedAt,
  });

  final Book book;
  final BookSource source;

  /// API base URL for [BookSource.api] entries, or `sample` for samples.
  final String origin;
  final DateTime addedAt;
  final DownloadState download;
  final ReadingProgress? progress;
  final DateTime? lastOpenedAt;

  /// Namespaces the catalog id by source and origin, including on disk.
  static String identity(String bookId, BookSource source, String origin) =>
      sha256.convert(utf8.encode('${source.name}\n$origin\n$bookId')).toString();

  String get id => identity(book.id, source, origin);

  LibraryEntry copyWith({
    Book? book,
    DownloadState? download,
    ReadingProgress? progress,
    DateTime? lastOpenedAt,
    bool clearProgress = false,
  }) => LibraryEntry(
    book: book ?? this.book,
    source: source,
    origin: origin,
    addedAt: addedAt,
    download: download ?? this.download,
    progress: clearProgress ? null : (progress ?? this.progress),
    lastOpenedAt: lastOpenedAt ?? this.lastOpenedAt,
  );

  Map<String, dynamic> toJson() => {
    'book': book.toJson(),
    'source': source.name,
    'origin': origin,
    'addedAt': addedAt.toUtc().toIso8601String(),
    'download': download.toJson(),
    'progress': progress?.toJson(),
    'lastOpenedAt': lastOpenedAt?.toUtc().toIso8601String(),
  };

  factory LibraryEntry.fromJson(Map<String, dynamic> json) => LibraryEntry(
    book: Book.fromJson((json['book'] as Map).cast<String, dynamic>()),
    source: BookSource.values.byName(json['source'] as String? ?? 'api'),
    origin: json['origin'] as String? ?? '',
    addedAt: DateTime.parse(json['addedAt'] as String),
    download: json['download'] == null
        ? const DownloadState()
        : DownloadState.fromJson((json['download'] as Map).cast<String, dynamic>()),
    progress: json['progress'] == null
        ? null
        : ReadingProgress.fromJson((json['progress'] as Map).cast<String, dynamic>()),
    lastOpenedAt: json['lastOpenedAt'] == null
        ? null
        : DateTime.parse(json['lastOpenedAt'] as String),
  );
}
