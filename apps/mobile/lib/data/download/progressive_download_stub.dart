import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import 'downloader.dart';
import 'progressive_download.dart';
import 'segment_plan.dart';

Future<ProgressiveDownload?> createProgressiveDownload({
  required BookStore store,
  required Book book,
  required String storageId,
  required ApiClient client,
  required ProgressCallback onProgress,
  required void Function() onReadable,
  SegmentPolicy policy = const SegmentPolicy(),
}) async => null;
