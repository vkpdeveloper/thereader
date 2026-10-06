import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Raw bytes of a fetched page. Decoding happens off the UI thread together
/// with extraction (see `decodeHtml`).
class FetchedPage {
  const FetchedPage({required this.url, required this.bytes, this.contentType});

  /// Final URL after redirects.
  final Uri url;
  final Uint8List bytes;
  final String? contentType;
}

class ArticleFetchException implements Exception {
  const ArticleFetchException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Fetches article pages on the client, never through a backend reader.
/// Native platforms have no CORS and request the page directly with a
/// desktop browser's headers. The browser preview cannot, so it asks the
/// API's `/v1/article-source` relay for the raw bytes, upstream Content-Type
/// and `X-Final-Url`.
class PageFetcher {
  PageFetcher({
    http.Client? client,
    required this.relayBase,
    this.useRelay = kIsWeb,
    this.timeout = const Duration(seconds: 20),
    this.maxBytes = 8 * 1024 * 1024,
  }) : _client = client ?? http.Client();

  static const headers = {
    'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  final http.Client _client;

  /// API origin for the relay, read at fetch time so it follows Settings.
  final Uri Function() relayBase;
  final bool useRelay;
  final Duration timeout;
  final int maxBytes;

  /// Reports download progress as a fraction, or null while the size is
  /// unknown.
  Future<FetchedPage> fetch(Uri url, {ValueChanged<double?>? onProgress}) async {
    final abort = Completer<void>();
    final timer = Timer(timeout, abort.complete);
    try {
      final target = useRelay
          ? relayBase().replace(path: '/v1/article-source', queryParameters: {'url': url.toString()})
          : url;
      final request = http.AbortableRequest('GET', target, abortTrigger: abort.future)..maxRedirects = 10;
      if (!useRelay) request.headers.addAll(headers);
      final response = await _client.send(request);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final body = await _read(response, 64 * 1024, null);
        throw ArticleFetchException(_statusMessage(response.statusCode, body));
      }
      final contentType = response.headers['content-type'];
      if (!_isHtml(contentType)) {
        throw ArticleFetchException("That link isn't a web page (${contentType!.split(';').first.trim()}).");
      }
      final length = response.contentLength;
      if (length != null && length > maxBytes) throw const ArticleFetchException('That page is too large to save.');
      final bytes = await _read(response, maxBytes, (received) => onProgress?.call(length == null || length == 0 ? null : received / length));
      final finalUrl = useRelay
          ? Uri.tryParse(response.headers['x-final-url'] ?? '') ?? url
          : switch (response) {
              http.BaseResponseWithUrl(url: final redirected) => redirected,
              _ => url,
            };
      return FetchedPage(url: finalUrl, bytes: bytes, contentType: contentType);
    } on ArticleFetchException {
      rethrow;
    } on http.RequestAbortedException {
      throw const ArticleFetchException('The page took too long to respond.');
    } on http.ClientException catch (e) {
      throw ArticleFetchException(
        abort.isCompleted ? 'The page took too long to respond.' : "Couldn't reach that page. ${e.message}".trim(),
      );
    } finally {
      timer.cancel();
    }
  }

  Future<Uint8List> _read(http.StreamedResponse response, int cap, void Function(int received)? progress) async {
    final out = BytesBuilder(copy: false);
    await for (final chunk in response.stream) {
      out.add(chunk);
      if (out.length > cap) {
        if (progress == null) break;
        throw const ArticleFetchException('That page is too large to save.');
      }
      progress?.call(out.length);
    }
    return out.takeBytes();
  }

  static bool _isHtml(String? contentType) {
    if (contentType == null) return true;
    final mime = contentType.split(';').first.trim().toLowerCase();
    return mime.isEmpty || mime == 'text/html' || mime == 'application/xhtml+xml';
  }

  String _statusMessage(int status, Uint8List body) {
    if (useRelay) {
      try {
        final error = (jsonDecode(utf8.decode(body)) as Map)['error'] as Map;
        final message = error['message'];
        if (message is String && message.isNotEmpty) return message;
      } catch (_) {}
    }
    return switch (status) {
      401 || 403 => 'That site refused the request ($status).',
      404 || 410 => "That page doesn't exist ($status).",
      429 => 'That site is rate limiting requests. Try again later.',
      >= 500 => 'That site had a problem ($status). Try again later.',
      _ => 'That site responded with $status.',
    };
  }

  void close() => _client.close();
}
