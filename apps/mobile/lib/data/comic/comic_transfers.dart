/// Comic downloads handed to the operating system (docs/comics.md,
/// "Downloads"): URLSession on iOS, WorkManager / user-initiated jobs with a
/// progress notification on Android. They continue while the app is in the
/// background or killed; the library reconciles with them at launch.
///
/// This interface keeps `background_downloader` out of the library logic so
/// that state mapping and reconciliation are testable with a fake.
library;

import 'comic_transfers_stub.dart'
    if (dart.library.io) 'comic_transfers_io.dart'
    as impl;

enum TransferState {
  enqueued,
  running,
  paused,
  retrying,
  complete,
  failed,
  canceled,

  /// The server answered 404: the comic is gone.
  notFound;

  bool get isActive => switch (this) {
    enqueued || running || paused || retrying => true,
    _ => false,
  };
}

/// One status or progress report. A transfer's id is its library entry id.
class ComicTransfer {
  const ComicTransfer({
    required this.entryId,
    required this.state,
    this.progress,
    this.sha256,
    this.error,
  });

  final String entryId;
  final TransferState state;

  /// 0–1 while running, when known.
  final double? progress;

  /// The edition the transfer was started for (persisted records only).
  final String? sha256;
  final String? error;

  @override
  String toString() => 'ComicTransfer($entryId, ${state.name}, $progress)';
}

class ComicTransferRequest {
  const ComicTransferRequest({
    required this.entryId,
    required this.url,
    required this.headers,
    required this.displayName,
    required this.sha256,
    required this.fileSize,
  });

  final String entryId;
  final Uri url;
  final Map<String, String> headers;
  final String displayName;
  final String sha256;
  final int fileSize;
}

abstract class ComicTransfers {
  /// Status and progress of comic transfers, including ones that finished
  /// while the app was suspended or not running (delivered after [start]).
  Stream<ComicTransfer> get updates;

  /// Starts listening to the OS downloader and returns the persisted
  /// transfers. Subscribe to [updates] first.
  Future<List<ComicTransfer>> start();

  Future<bool> enqueue(ComicTransferRequest request);

  /// Cancels the OS task, if any.
  Future<void> cancel(String entryId);

  /// Where the finished file of [entryId] is, outside the book store (whose
  /// launch cleanup deletes partial files).
  Future<String> filePath(String entryId);

  /// Drops the persisted record and any file left behind.
  Future<void> forget(String entryId);

  /// Android 13+ needs permission for the progress notification; asked at
  /// the first comic download.
  Future<void> requestNotificationPermission();

  /// The platform implementation, or null where comics download in-app.
  static ComicTransfers? create() => impl.createComicTransfers();
}

/// Whether the file at [path] is exactly [size] bytes with [sha256], checked
/// off the UI isolate.
Future<bool> verifyTransferredFile(String path, int size, String sha256) =>
    impl.verifyTransferredFile(path, size, sha256);
