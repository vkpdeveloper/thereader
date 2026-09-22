import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import 'downloader.dart';
import 'progressive_download.dart';

Future<ProgressiveDownload?> createProgressiveDownload({
  required BookStore store,
  required Book book,
  required String storageId,
  required ApiClient client,
  required ProgressCallback onProgress,
  required void Function() onReadable,
}) async => null;
