import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import 'downloader.dart';
import 'segment_plan.dart';
import 'progressive_download_stub.dart'
    if (dart.library.io) 'progressive_download_io.dart'
    as platform;

/// Downloads one edition as parallel, edition-pinned byte ranges while the
/// reader may already read it. Sparse bytes only become a durable offline
/// publication after the final full-file SHA verification.
abstract class ProgressiveDownload {
  bool get canRead;
  Future<String> run();
  Future<BookFile> open();
  Future<void> cancel();
  Future<void> release();

  static Future<ProgressiveDownload?> create({
    required BookStore store,
    required Book book,
    required String storageId,
    required ApiClient client,
    required ProgressCallback onProgress,
    required void Function() onReadable,
    SegmentPolicy policy = const SegmentPolicy(),
  }) => platform.createProgressiveDownload(
    store: store,
    book: book,
    storageId: storageId,
    client: client,
    onProgress: onProgress,
    onReadable: onReadable,
    policy: policy,
  );
}
