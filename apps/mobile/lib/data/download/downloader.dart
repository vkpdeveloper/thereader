import 'dart:async';

import 'package:crypto/crypto.dart';

import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';

class DownloadFailure implements Exception {
  DownloadFailure(this.message, {this.code = 'DOWNLOAD_FAILED'});
  final String message;
  final String code;
  @override
  String toString() => message;
}

class DownloadCancelled implements Exception {}

typedef ProgressCallback = void Function(int received, int? total);

/// Streams a book into the [BookStore], hashing as it goes, and only commits
/// when the byte count and SHA-256 match the catalog record.
class Downloader {
  Downloader({required this.store});

  final BookStore store;

  Future<String> download({
    required Book book,
    required DownloadStream source,
    required ProgressCallback onProgress,
    required bool Function() isCancelled,
  }) async {
    final expectedSize = book.fileSize;
    final headerLength = source.contentLength;
    if (headerLength != null && headerLength > 0 && headerLength != expectedSize) {
      throw DownloadFailure(
        'The server reported $headerLength bytes but the catalog says $expectedSize.',
        code: 'SIZE_MISMATCH',
      );
    }

    final sink = await store.openSink(bookId: book.id, version: book.version);
    final digestSink = _DigestSink();
    final hasher = sha256.startChunkedConversion(digestSink);
    var received = 0;
    var lastReport = 0;
    try {
      await for (final chunk in source.stream) {
        if (isCancelled()) throw DownloadCancelled();
        received += chunk.length;
        if (received > expectedSize) {
          throw DownloadFailure('Received more data than the catalog size ($expectedSize bytes).',
              code: 'SIZE_MISMATCH');
        }
        hasher.add(chunk);
        await sink.add(chunk);
        if (received - lastReport >= 32 * 1024 || received == expectedSize) {
          lastReport = received;
          onProgress(received, expectedSize);
        }
      }
      hasher.close();
      if (received != expectedSize) {
        throw DownloadFailure('Download ended early: $received of $expectedSize bytes.',
            code: 'SIZE_MISMATCH');
      }
      final actual = digestSink.digest!.toString();
      if (actual != book.sha256) {
        throw DownloadFailure('Checksum did not match the catalog. The file was discarded.',
            code: 'CHECKSUM_MISMATCH');
      }
      return await sink.commit();
    } catch (e) {
      await sink.abort();
      rethrow;
    }
  }
}

class _DigestSink implements Sink<Digest> {
  Digest? digest;
  @override
  void add(Digest data) => digest = data;
  @override
  void close() {}
}
