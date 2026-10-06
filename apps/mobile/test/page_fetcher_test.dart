import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:thereader/data/articles/page_fetcher.dart';

class _Redirected extends http.StreamedResponse implements http.BaseResponseWithUrl {
  _Redirected(super.stream, super.statusCode, {required this.url, super.headers, super.contentLength});

  @override
  final Uri url;
}

/// Answers with [respond], honouring abort triggers like the real clients.
class _FakeClient extends http.BaseClient {
  _FakeClient(this.respond);

  final FutureOr<http.StreamedResponse> Function(http.BaseRequest request) respond;
  final List<http.BaseRequest> requests = [];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    final response = Future.value(respond(request));
    final abort = request is http.Abortable ? request.abortTrigger : null;
    if (abort == null) return response;
    return Future.any([response, abort.then<http.StreamedResponse>((_) => throw http.RequestAbortedException(request.url))]);
  }
}

http.StreamedResponse html(String body, {int status = 200, String type = 'text/html; charset=utf-8', Uri? url}) {
  final bytes = utf8.encode(body);
  final headers = {'content-type': type};
  return url == null
      ? http.StreamedResponse(Stream.value(bytes), status, headers: headers, contentLength: bytes.length)
      : _Redirected(Stream.value(bytes), status, url: url, headers: headers, contentLength: bytes.length);
}

PageFetcher fetcher(http.Client client, {bool relay = false, Duration timeout = const Duration(seconds: 5), int maxBytes = 1 << 20}) =>
    PageFetcher(
      client: client,
      relayBase: () => Uri.parse('https://reader.example'),
      useRelay: relay,
      timeout: timeout,
      maxBytes: maxBytes,
    );

void main() {
  test('fetches directly with browser headers and keeps the final URL', () async {
    final client = _FakeClient((_) => html('<p>hi</p>', url: Uri.parse('https://example.com/final')));
    final page = await fetcher(client).fetch(Uri.parse('https://example.com/start'));
    final request = client.requests.single;
    expect(request.url, Uri.parse('https://example.com/start'));
    expect(request.headers['User-Agent'], contains('Chrome/129.0.0.0 Safari/537.36'));
    expect(request.headers['Accept'], startsWith('text/html,application/xhtml+xml'));
    expect(request.headers['Accept-Language'], 'en-US,en;q=0.9');
    expect(request.followRedirects, isTrue);
    expect(page.url, Uri.parse('https://example.com/final'));
    expect(utf8.decode(page.bytes), '<p>hi</p>');
    expect(page.contentType, 'text/html; charset=utf-8');
  });

  test('reports download progress', () async {
    final seen = <double?>[];
    await fetcher(_FakeClient((_) => html('x' * 100))).fetch(Uri.parse('https://example.com/'), onProgress: seen.add);
    expect(seen.last, 1.0);
  });

  test('accepts XHTML and untyped pages but rejects other media', () async {
    await fetcher(_FakeClient((_) => html('<p/>', type: 'application/xhtml+xml'))).fetch(Uri.parse('https://e.com/'));
    final pdf = fetcher(_FakeClient((_) => html('%PDF', type: 'application/pdf'))).fetch(Uri.parse('https://e.com/a.pdf'));
    await expectLater(pdf, throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains('application/pdf'))));
  });

  test('caps the page size with and without a Content-Length', () async {
    final declared = fetcher(_FakeClient((_) => html('x' * 2000)), maxBytes: 1000).fetch(Uri.parse('https://e.com/'));
    await expectLater(declared, throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains('too large'))));
    final streamed = fetcher(
      _FakeClient((_) => http.StreamedResponse(Stream.fromIterable([List.filled(600, 120), List.filled(600, 120)]), 200)),
      maxBytes: 1000,
    ).fetch(Uri.parse('https://e.com/'));
    await expectLater(streamed, throwsA(isA<ArticleFetchException>()));
  });

  test('turns error statuses into readable messages', () async {
    final missing = fetcher(_FakeClient((_) => html('nope', status: 404))).fetch(Uri.parse('https://e.com/x'));
    await expectLater(missing, throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains('404'))));
  });

  test('times out slow pages', () async {
    final never = Completer<http.StreamedResponse>();
    final slow = fetcher(_FakeClient((_) => never.future), timeout: const Duration(milliseconds: 50)).fetch(Uri.parse('https://e.com/'));
    await expectLater(slow, throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains('too long'))));
  });

  test('the browser preview goes through the API relay', () async {
    final client = _FakeClient(
      (_) => http.StreamedResponse(
        Stream.value(utf8.encode('<p>relayed</p>')),
        200,
        headers: {'content-type': 'text/html; charset=windows-1252', 'x-final-url': 'https://example.com/after'},
      ),
    );
    final page = await fetcher(client, relay: true).fetch(Uri.parse('https://example.com/before?a=1'));
    final url = client.requests.single.url;
    expect(url.origin, 'https://reader.example');
    expect(url.path, '/v1/article-source');
    expect(url.queryParameters['url'], 'https://example.com/before?a=1');
    expect(client.requests.single.headers.containsKey('User-Agent'), isFalse);
    expect(page.url, Uri.parse('https://example.com/after'));
    expect(page.contentType, 'text/html; charset=windows-1252');

    final refused = fetcher(
      _FakeClient((_) => html(jsonEncode({'error': {'code': 'BLOCKED', 'message': 'That host is not allowed.'}}), status: 400, type: 'application/json')),
      relay: true,
    ).fetch(Uri.parse('https://example.com/'));
    await expectLater(refused, throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', 'That host is not allowed.')));
  });
}
