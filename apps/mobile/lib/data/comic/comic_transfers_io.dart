import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:background_downloader/background_downloader.dart';
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'comic_transfers.dart';

ComicTransfers? createComicTransfers() =>
    Platform.isAndroid || Platform.isIOS ? BackgroundComicTransfers() : null;

Future<bool> verifyTransferredFile(String path, int size, String sha) =>
    Isolate.run(() async {
      final file = File(path);
      if (!await file.exists() || await file.length() != size) return false;
      return (await sha256.bind(file.openRead()).first).toString() == sha;
    });

/// [ComicTransfers] on `background_downloader`. Every comic is one
/// [DownloadTask] in the `comics` group whose task id is the library entry id.
class BackgroundComicTransfers implements ComicTransfers {
  static const group = 'comics';
  static const _directory = 'comic-transfers';

  final _updates = StreamController<ComicTransfer>.broadcast();
  bool _askedPermission = false;

  FileDownloader get _downloader => FileDownloader();

  @override
  Stream<ComicTransfer> get updates => _updates.stream;

  @override
  Future<List<ComicTransfer>> start() async {
    _downloader
      ..registerCallbacks(
        group: group,
        taskStatusCallback: (update) => _updates.add(
          ComicTransfer(
            entryId: update.task.taskId,
            state: _state(update.status),
            sha256: _sha(update.task),
            error: update.exception?.description,
          ),
        ),
        taskProgressCallback: (update) {
          // Negative values signal terminal states, which arrive as status.
          if (update.progress < 0) return;
          _updates.add(
            ComicTransfer(
              entryId: update.task.taskId,
              state: TransferState.running,
              progress: update.progress,
              sha256: _sha(update.task),
            ),
          );
        },
      )
      ..configureNotificationForGroup(
        group,
        running: const TaskNotification('{displayName}', 'Downloading comic'),
        complete: const TaskNotification('{displayName}', 'Downloaded'),
        error: const TaskNotification('{displayName}', 'Download failed'),
        paused: const TaskNotification('{displayName}', 'Paused'),
        progressBar: true,
      );
    // Tracks tasks in the database, marks transfers that finished while the
    // app was not running complete, replays queued background updates and
    // (after 5 s) re-enqueues tasks the OS dropped when the app was killed.
    await _downloader.start(autoCleanDatabase: true);
    final records = await _downloader.database.allRecords(group: group);
    return [
      for (final record in records)
        ComicTransfer(
          entryId: record.taskId,
          state: _state(record.status),
          progress: record.progress >= 0 ? record.progress : null,
          sha256: _sha(record.task),
          error: record.exception?.description,
        ),
    ];
  }

  @override
  Future<bool> enqueue(ComicTransferRequest request) =>
      _downloader.enqueue(_task(request));

  DownloadTask _task(ComicTransferRequest request) => DownloadTask(
    taskId: request.entryId,
    url: request.url.toString(),
    headers: request.headers,
    baseDirectory: BaseDirectory.applicationSupport,
    directory: _directory,
    filename: _fileName(request.entryId),
    group: group,
    updates: Updates.statusAndProgress,
    retries: 3,
    displayName: request.displayName,
    metaData: jsonEncode({
      'sha256': request.sha256,
      'fileSize': request.fileSize,
    }),
    // Priority 0 with a notification: Android 14+ runs it as a user-initiated
    // data transfer (no time limit); older versions pause and resume across
    // WorkManager's 9-minute windows.
    transferHints: const {TransferHint.userInitiated, TransferHint.largeFile},
  );

  @override
  Future<void> cancel(String entryId) async {
    await _downloader.cancelTaskWithId(entryId);
  }

  @override
  Future<String> filePath(String entryId) async {
    final record = await _downloader.database.recordForId(entryId);
    if (record != null) return record.task.filePath();
    final support = await getApplicationSupportDirectory();
    return p.join(support.path, _directory, _fileName(entryId));
  }

  @override
  Future<void> forget(String entryId) async {
    final path = await filePath(entryId);
    await _downloader.database.deleteRecordWithId(entryId);
    try {
      final file = File(path);
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Best effort: the next launch's records no longer reference it.
    }
  }

  @override
  Future<void> requestNotificationPermission() async {
    if (!Platform.isAndroid || _askedPermission) return;
    _askedPermission = true;
    final permissions = _downloader.permissions;
    if (await permissions.status(PermissionType.notifications) !=
        PermissionStatus.granted) {
      await permissions.request(PermissionType.notifications);
    }
  }

  static String _fileName(String entryId) =>
      '${sha256.convert(utf8.encode(entryId)).toString().substring(0, 32)}.cbz';

  static String? _sha(Task task) {
    try {
      return (jsonDecode(task.metaData) as Map)['sha256'] as String?;
    } catch (_) {
      return null;
    }
  }

  static TransferState _state(TaskStatus status) => switch (status) {
    TaskStatus.enqueued => TransferState.enqueued,
    TaskStatus.running => TransferState.running,
    TaskStatus.paused => TransferState.paused,
    TaskStatus.waitingToRetry => TransferState.retrying,
    TaskStatus.complete => TransferState.complete,
    TaskStatus.failed => TransferState.failed,
    TaskStatus.canceled => TransferState.canceled,
    TaskStatus.notFound => TransferState.notFound,
  };
}
