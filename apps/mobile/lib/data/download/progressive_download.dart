import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import 'downloader.dart';
import 'progressive_download_stub.dart'
    if (dart.library.io) 'progressive_download_io.dart'
    as platform;

/// Sparse bytes are edition-pinned over HTTP, but only the final full-file SHA
/// verification makes them a durable offline publication.
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
  }) => platform.createProgressiveDownload(
    store: store,
    book: book,
    storageId: storageId,
    client: client,
    onProgress: onProgress,
    onReadable: onReadable,
  );
}
