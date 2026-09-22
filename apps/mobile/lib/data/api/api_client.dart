import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../models/book.dart';

class ApiException implements Exception {
  ApiException(
    this.message, {
    this.code = 'UNKNOWN',
    this.statusCode,
    this.isNetwork = false,
  });

  final String message;
  final String code;
  final int? statusCode;

  /// True when the request never reached a server (offline, DNS, refused).
  final bool isNetwork;

  @override
  String toString() =>
      'ApiException($code${statusCode == null ? '' : ' $statusCode'}): $message';
}

class BookPage {
  const BookPage({required this.items, required this.nextCursor});
  final List<Book> items;
  final String? nextCursor;
}

class DownloadStream {
  const DownloadStream({
    required this.stream,
    required this.contentLength,
    this.etag,
  });
  final Stream<List<int>> stream;
  final int? contentLength;
  final String? etag;
}

class HealthStatus {
  const HealthStatus({required this.ok, required this.service, this.detail});
  final bool ok;
  final String service;
  final String? detail;
}

/// Thin HTTP client for the reader API. No auth, no tokens; the base URL is
/// the only configuration.
class ApiClient {
  ApiClient({
    required String baseUrl,
    http.Client? client,
    this.timeout = const Duration(seconds: 15),
  }) : baseUri = normalizeBaseUrl(baseUrl),
       _client = client ?? http.Client();

  final Uri baseUri;
  final http.Client _client;
  final Duration timeout;

  static Uri normalizeBaseUrl(String raw) {
    var s = raw.trim();
    if (s.isEmpty) throw ApiException('API URL is empty.', code: 'BAD_URL');
    if (!s.contains('://')) s = 'http://$s';
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    final uri = Uri.tryParse(s);
    if (uri == null ||
        uri.host.isEmpty ||
        !(uri.scheme == 'http' || uri.scheme == 'https')) {
      throw ApiException('API URL must be an http(s) origin.', code: 'BAD_URL');
    }
    return uri;
  }

  /// Resolves contract URLs that may be relative to the API origin.
  Uri resolve(String pathOrUrl) => baseUri.resolve(pathOrUrl);

  Future<HealthStatus> health() async {
    final json = await _getJson(resolve('/health'));
    return HealthStatus(
      ok: json['status'] == 'ok',
      service: json['service']?.toString() ?? 'unknown',
    );
  }

  Future<BookPage> listBooks({
    int limit = 24,
    String? cursor,
    String? query,
  }) async {
    final params = <String, String>{'limit': '$limit'};
    if (cursor != null && cursor.isNotEmpty) params['cursor'] = cursor;
    if (query != null && query.trim().isNotEmpty) params['q'] = query.trim();
    final uri = resolve('/v1/books').replace(queryParameters: params);
    final json = await _getJson(uri);
    final items = (json['items'] as List<dynamic>? ?? const [])
        .map((e) => Book.fromJson((e as Map).cast<String, dynamic>()))
        .toList(growable: false);
    return BookPage(items: items, nextCursor: json['nextCursor'] as String?);
  }

  Future<Book> getBook(String id) async {
    final json = await _getJson(
      resolve('/v1/books/${Uri.encodeComponent(id)}'),
    );
    return Book.fromJson((json['book'] as Map).cast<String, dynamic>());
  }

  /// Opens a streamed download. The caller consumes the stream incrementally.
  Future<DownloadStream> openDownload(Book book) async {
    final uri = resolve(book.downloadUrl);
    final request = http.Request('GET', uri)
      ..headers['accept'] = 'application/epub+zip';
    final http.StreamedResponse response;
    try {
      response = await _client.send(request).timeout(timeout);
    } on TimeoutException {
      throw ApiException(
        'Timed out connecting to ${uri.host}.',
        code: 'TIMEOUT',
        isNetwork: true,
      );
    } on http.ClientException catch (e) {
      throw ApiException(
        _friendlyNetwork(e.message, uri),
        code: 'NETWORK',
        isNetwork: true,
      );
    }
    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      throw _errorFrom(response.statusCode, body);
    }
    return DownloadStream(
      stream: response.stream,
      contentLength: response.contentLength,
      etag: response.headers['etag'],
    );
  }

  /// Fetch exactly one bounded, edition-pinned range. Convenience for callers
  /// needing the whole range; progressive downloads use [streamRange] instead.
  Future<Uint8List> readRange(Book book, int start, int end) async {
    final bytes = BytesBuilder(copy: false);
    await streamRange(
      book,
      start,
      end,
      onChunk: (chunk) async => bytes.add(chunk),
    );
    return bytes.takeBytes();
  }

  /// Deliver fixed-size chunks with backpressure after validating the edition
  /// and range headers. The final chunk waits for EOF and exact body length.
  /// Earlier chunks are provisional until the caller verifies the whole EPUB.
  Future<void> streamRange(
    Book book,
    int start,
    int end, {
    required Future<void> Function(Uint8List chunk) onChunk,
    int chunkSize = 64 * 1024,
    Future<void>? abortTrigger,
  }) async {
    if (start < 0 || end <= start || end > book.fileSize || chunkSize <= 0) {
      throw RangeError('Invalid EPUB range');
    }
    final uri = resolve(book.downloadUrl);
    final requestAbort = Completer<void>();
    void abortRequest() {
      if (!requestAbort.isCompleted) requestAbort.complete();
    }

    var discardLateResponse = false;
    final externalAbort = abortTrigger?.then<void>((_) {
      discardLateResponse = true;
      abortRequest();
    });
    final request =
        http.AbortableRequest('GET', uri, abortTrigger: requestAbort.future)
          ..headers.addAll({
            'accept': 'application/epub+zip',
            'accept-encoding': 'identity',
            'range': 'bytes=$start-${end - 1}',
            'if-range': '"${book.sha256}"',
          });
    Future<T> abortable<T>(Future<T> operation) => externalAbort == null
        ? operation
        : Future.any([
            operation,
            externalAbort.then<T>(
              (_) => throw http.RequestAbortedException(uri),
            ),
          ]);
    // A custom client may ignore AbortableRequest. Keep observing its original
    // future so a response arriving after cancellation or timeout is closed.
    final sending = _client.send(request).then<http.StreamedResponse>((
      late,
    ) async {
      if (discardLateResponse) {
        await _discardResponse(late);
        throw http.RequestAbortedException(uri);
      }
      return late;
    });
    final http.StreamedResponse response;
    try {
      response = await abortable(
        sending.timeout(
          timeout,
          onTimeout: () {
            discardLateResponse = true;
            abortRequest();
            throw TimeoutException('Range request timed out.', timeout);
          },
        ),
      );
    } on http.RequestAbortedException {
      rethrow;
    } on TimeoutException {
      throw ApiException(
        'Timed out connecting to ${uri.host}.',
        code: 'TIMEOUT',
        isNetwork: true,
      );
    } on http.ClientException catch (e) {
      throw ApiException(
        _friendlyNetwork(e.message, uri),
        code: 'NETWORK',
        isNetwork: true,
      );
    }
    final expectedRange = 'bytes $start-${end - 1}/${book.fileSize}';
    if (response.statusCode != 206 ||
        response.headers['content-range'] != expectedRange ||
        response.headers['etag'] != '"${book.sha256}"' ||
        (response.contentLength != null &&
            response.contentLength != end - start) ||
        (response.headers['content-encoding'] != null &&
            response.headers['content-encoding'] != 'identity')) {
      await _discardResponse(response);
      throw ApiException(
        'The book changed or the server cannot stream this edition. Retry the download.',
        code: 'INVALID_RANGE',
        statusCode: response.statusCode,
      );
    }
    final input = StreamIterator(response.stream.timeout(timeout));
    var buffer = Uint8List(chunkSize);
    var filled = 0;
    var received = 0;
    try {
      while (await abortable(input.moveNext())) {
        final incoming = input.current;
        if (received + incoming.length > end - start) {
          throw ApiException(
            'The server returned too many bytes.',
            code: 'INVALID_RANGE',
          );
        }
        var offset = 0;
        while (offset < incoming.length) {
          final available = chunkSize - filled;
          final take = incoming.length - offset < available
              ? incoming.length - offset
              : available;
          buffer.setRange(filled, filled + take, incoming, offset);
          filled += take;
          received += take;
          offset += take;
          if (filled == chunkSize && received < end - start) {
            await abortable(onChunk(buffer));
            buffer = Uint8List(chunkSize);
            filled = 0;
          }
        }
      }
      if (received != end - start) {
        throw ApiException(
          'The book download was interrupted.',
          code: 'TRUNCATED_RANGE',
        );
      }
      if (filled > 0) {
        await abortable(onChunk(Uint8List.sublistView(buffer, 0, filled)));
      }
    } on http.RequestAbortedException {
      rethrow;
    } on TimeoutException {
      abortRequest();
      throw ApiException(
        'The book download timed out.',
        code: 'TIMEOUT',
        isNetwork: true,
      );
    } on http.ClientException catch (e) {
      abortRequest();
      throw ApiException(
        _friendlyNetwork(e.message, uri),
        code: 'NETWORK',
        isNetwork: true,
      );
    } finally {
      await input.cancel();
    }
  }

  static Future<void> _discardResponse(http.StreamedResponse response) async {
    try {
      await response.stream.listen((_) {}, onError: (_) {}).cancel();
    } catch (_) {
      // The response is already unusable; cancellation is best effort.
    }
  }

  Future<Map<String, dynamic>> _getJson(Uri uri) async {
    final http.Response response;
    try {
      response = await _client
          .get(uri, headers: const {'accept': 'application/json'})
          .timeout(timeout);
    } on TimeoutException {
      throw ApiException(
        'Timed out connecting to ${uri.host}.',
        code: 'TIMEOUT',
        isNetwork: true,
      );
    } on http.ClientException catch (e) {
      throw ApiException(
        _friendlyNetwork(e.message, uri),
        code: 'NETWORK',
        isNetwork: true,
      );
    }
    if (response.statusCode != 200) {
      throw _errorFrom(response.statusCode, response.body);
    }
    try {
      return (jsonDecode(response.body) as Map).cast<String, dynamic>();
    } on FormatException {
      throw ApiException(
        'The server returned something that is not JSON.',
        code: 'BAD_RESPONSE',
        statusCode: response.statusCode,
      );
    }
  }

  static String _friendlyNetwork(String raw, Uri uri) {
    final lower = raw.toLowerCase();
    if (lower.contains('refused')) {
      return 'Nothing is listening at ${uri.host}:${uri.port}.';
    }
    if (lower.contains('failed host lookup') ||
        lower.contains('name not resolved')) {
      return 'Could not find ${uri.host}.';
    }
    return 'Could not reach ${uri.host}.';
  }

  static ApiException _errorFrom(int status, String body) {
    try {
      final json = (jsonDecode(body) as Map).cast<String, dynamic>();
      final err = (json['error'] as Map?)?.cast<String, dynamic>();
      if (err != null) {
        return ApiException(
          err['message']?.toString() ?? 'Request failed.',
          code: err['code']?.toString() ?? 'HTTP_$status',
          statusCode: status,
        );
      }
    } catch (_) {}
    return ApiException(
      'Request failed with HTTP $status.',
      code: 'HTTP_$status',
      statusCode: status,
    );
  }

  void close() => _client.close();
}
