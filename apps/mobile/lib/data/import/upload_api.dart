import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../api/api_client.dart';
import '../models/book.dart';

class PreparedUpload {
  PreparedUpload({
    required this.book,
    required this.uploaded,
    this.uploadUrl,
    this.multipart,
  });
  final Book book;
  final bool uploaded;
  final String? uploadUrl;
  final MultipartUpload? multipart;
}

class MultipartUpload {
  const MultipartUpload({
    required this.uploadId,
    required this.partSize,
    required this.parts,
  });
  final String uploadId;
  final int partSize;
  final Map<int, String> parts;

  factory MultipartUpload.fromJson(Map<String, dynamic> json, int fileSize) {
    final id = json['uploadId'];
    final size = json['partSize'];
    final listed = json['parts'];
    if (id is! String ||
        id.isEmpty ||
        id.length > 1024 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(id) ||
        size != 8 * 1024 * 1024 ||
        listed is! List ||
        listed.length > 64) {
      throw ApiException(
        'The multipart upload response is invalid.',
        code: 'BAD_RESPONSE',
      );
    }
    final count = (fileSize + (size as int) - 1) ~/ size;
    final parts = <int, String>{};
    for (final raw in listed) {
      final number = raw is Map ? raw['partNumber'] : null;
      final etag = raw is Map ? raw['etag'] : null;
      if (number is! int ||
          number < 1 ||
          number > count ||
          parts.containsKey(number) ||
          etag is! String ||
          etag.isEmpty ||
          etag.length > 1024) {
        throw ApiException(
          'The uploaded part list is invalid.',
          code: 'BAD_RESPONSE',
        );
      }
      parts[number] = etag;
    }
    return MultipartUpload(
      uploadId: id,
      partSize: size,
      parts: Map.unmodifiable(parts),
    );
  }
}

/// One owned HTTP connection pool per queue attempt. Closing it aborts upload;
/// it never disposes the app's shared catalog ApiClient.
class UploadApi {
  UploadApi(this.origin, {http.Client? client})
    : _client = client ?? http.Client();
  final Uri origin;
  final http.Client _client;
  final _abort = Completer<void>();

  Future<PreparedUpload> prepare(Book book) async {
    final request =
        http.AbortableRequest(
            'POST',
            origin.resolve('/v1/uploads/prepare'),
            abortTrigger: _abort.future,
          )
          ..headers['content-type'] = 'application/json'
          ..body = jsonEncode({
            for (final key in [
              'sha256',
              'fileSize',
              'title',
              'author',
              'description',
              'language',
              'subjects',
            ])
              key: book.toJson()[key],
          });
    final json = await _send(request, const Duration(seconds: 30));
    final canonical = _book(json, book);
    final uploaded = json['uploaded'] == true;
    final url = json['uploadUrl'] as String?;
    final multipart = json['multipart'] is Map
        ? MultipartUpload.fromJson(
            (json['multipart'] as Map).cast(),
            book.fileSize,
          )
        : null;
    if (!uploaded && ((url == null) == (multipart == null))) {
      throw ApiException(
        'The upload response is incomplete.',
        code: 'BAD_RESPONSE',
      );
    }
    if (url != null) _uploadUri(url);
    return PreparedUpload(
      book: canonical,
      uploaded: uploaded,
      uploadUrl: url,
      multipart: multipart,
    );
  }

  Uri _uploadUri(String url) {
    final resolved = origin.resolve(url);
    if (resolved.origin != origin.origin ||
        resolved.userInfo.isNotEmpty ||
        !resolved.path.startsWith('/v1/uploads/')) {
      throw ApiException(
        'The server returned an invalid upload destination.',
        code: 'BAD_RESPONSE',
      );
    }
    return resolved;
  }

  Future<Book> upload(
    Book book,
    String url,
    Stream<List<int>> bytes, {
    required void Function(int sent) onProgress,
  }) async {
    var sent = 0;
    Stream<List<int>> body() async* {
      await for (final chunk in bytes) {
        sent += chunk.length;
        if (sent > book.fileSize) {
          throw const FormatException('The local EPUB changed before upload.');
        }
        onProgress(sent);
        yield chunk;
      }
      if (sent != book.fileSize) {
        throw const FormatException('The local EPUB is incomplete.');
      }
    }

    final request = _StreamingPut(_uploadUri(url), body(), _abort.future)
      ..contentLength = book.fileSize
      ..headers['content-type'] = 'application/epub+zip';
    final json = await _send(request, const Duration(minutes: 10));
    if (json['uploaded'] != true) {
      throw ApiException('The upload was not published.', code: 'BAD_RESPONSE');
    }
    return _book(json, book);
  }

  /// Each source range is consumed with transport backpressure. No 8 MiB part
  /// buffer is allocated: the caller supplies disk chunks of at most 64 KiB.
  /// Re-prepare on retry lists acknowledged parts and resumes server-side state.
  Future<Book> uploadMultipart(
    Book book,
    MultipartUpload multipart,
    Stream<List<int>> Function(int start, int end) readRange, {
    required void Function(int sent) onProgress,
  }) async {
    final count =
        (book.fileSize + multipart.partSize - 1) ~/ multipart.partSize;
    int endOf(int number) => number * multipart.partSize < book.fileSize
        ? number * multipart.partSize
        : book.fileSize;
    var acknowledged = multipart.parts.keys.fold<int>(
      0,
      (sum, number) => sum + endOf(number) - (number - 1) * multipart.partSize,
    );
    onProgress(acknowledged);
    for (var number = 1; number <= count; number++) {
      if (_abort.isCompleted) throw http.RequestAbortedException();
      if (multipart.parts.containsKey(number)) continue;
      final start = (number - 1) * multipart.partSize;
      final end = endOf(number);
      var sent = 0;
      Stream<List<int>> body() async* {
        await for (final chunk in readRange(start, end)) {
          sent += chunk.length;
          if (sent > end - start) {
            throw const FormatException(
              'The EPUB part contains too many bytes.',
            );
          }
          onProgress(acknowledged + sent);
          yield chunk;
        }
        if (sent != end - start) {
          throw const FormatException('The EPUB part is incomplete.');
        }
      }

      final request =
          _StreamingPut(
              _uploadUri('/v1/uploads/${book.sha256}/parts/$number'),
              body(),
              _abort.future,
            )
            ..contentLength = end - start
            ..headers.addAll({
              'content-type': 'application/octet-stream',
              'x-upload-id': multipart.uploadId,
            });
      final response = await _send(request, const Duration(minutes: 10));
      final etag = response['etag'];
      if (response['partNumber'] != number ||
          etag is! String ||
          etag.isEmpty ||
          etag.length > 1024) {
        throw ApiException(
          'The server did not acknowledge the EPUB part.',
          code: 'BAD_RESPONSE',
        );
      }
      acknowledged += end - start;
      onProgress(acknowledged);
    }
    if (_abort.isCompleted) throw http.RequestAbortedException();
    final complete =
        http.AbortableRequest(
            'POST',
            _uploadUri('/v1/uploads/${book.sha256}/complete'),
            abortTrigger: _abort.future,
          )
          ..headers['content-type'] = 'application/json'
          ..body = jsonEncode({'uploadId': multipart.uploadId});
    final response = await _send(complete, const Duration(minutes: 10));
    if (response['uploaded'] != true) {
      throw ApiException(
        'The EPUB is uploaded but has not passed verification.',
        code: 'BAD_RESPONSE',
      );
    }
    return _book(response, book);
  }

  Book _book(Map<String, dynamic> json, Book expected) {
    final book = Book.fromJson((json['book'] as Map).cast<String, dynamic>());
    if (book.sha256 != expected.sha256 || book.fileSize != expected.fileSize) {
      throw ApiException(
        'The upload response describes a different EPUB.',
        code: 'BAD_RESPONSE',
      );
    }
    return book;
  }

  Future<Map<String, dynamic>> _send(
    http.BaseRequest request,
    Duration timeout,
  ) async {
    // A catalog server cannot redirect private EPUB bytes to another origin.
    request.followRedirects = false;
    try {
      return await (() async {
        final response = await _client.send(request);
        final buffer = StringBuffer();
        var count = 0;
        await for (final text
            in response.stream
                .timeout(const Duration(seconds: 30))
                .transform(utf8.decoder)) {
          count += text.length;
          if (count > 256 * 1024) {
            throw ApiException(
              'The upload response is too large.',
              code: 'BAD_RESPONSE',
            );
          }
          buffer.write(text);
        }
        final json = (jsonDecode(buffer.toString()) as Map)
            .cast<String, dynamic>();
        if (response.statusCode != 200 && response.statusCode != 201) {
          final error = json['error'] as Map?;
          throw ApiException(
            error?['message'] as String? ?? 'Upload failed.',
            code: error?['code'] as String? ?? 'UPLOAD_FAILED',
            statusCode: response.statusCode,
          );
        }
        return json;
      })().timeout(
        timeout,
        onTimeout: () {
          close();
          throw ApiException(
            'Upload timed out. Your book is saved on this device.',
            code: 'TIMEOUT',
            isNetwork: true,
          );
        },
      );
    } on http.ClientException {
      throw ApiException(
        'Could not upload. Your book is saved on this device; retry when connected.',
        code: 'NETWORK',
        isNetwork: true,
      );
    }
  }

  void close() {
    if (!_abort.isCompleted) _abort.complete();
    _client.close();
  }
}

class _StreamingPut extends http.BaseRequest implements http.Abortable {
  _StreamingPut(Uri uri, this.bytes, this.abortTrigger) : super('PUT', uri);
  final Stream<List<int>> bytes;
  @override
  final Future<void>? abortTrigger;
  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(bytes);
  }
}
