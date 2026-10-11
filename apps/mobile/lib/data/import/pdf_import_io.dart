import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// PDF parsing lives in the independent Go package. Only the converted EPUB
/// enters the existing storage and Readium pipeline on the device.
Future<String> convertPdf(String sourcePath, Uri origin) async {
  final source = File(sourcePath);
  final size = await source.length();
  if (size == 0 || size > 64 * 1024 * 1024) {
    throw const FormatException('PDF imports are limited to 64 MiB.');
  }
  final directory = await Directory.systemTemp.createTemp('thereader-pdf-');
  final output = File(p.join(directory.path, 'reading-edition.epub'));
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  var timedOut = false;
  final timer = Timer(const Duration(seconds: 65), () {
    timedOut = true;
    client.close(force: true);
  });
  IOSink? sink;
  try {
    final request = await client.postUrl(origin.resolve('/v1/pdf/extract'));
    request.followRedirects = false;
    request.contentLength = size;
    request.headers.contentType = ContentType('application', 'pdf');
    request.headers.set('Accept', 'application/epub+zip');
    await request.addStream(source.openRead());
    final response = await request.close();
    if (response.statusCode != 200) {
      final bytes = <int>[];
      await for (final chunk in response) {
        if (bytes.length + chunk.length > 64 * 1024) break;
        bytes.addAll(chunk);
      }
      String message = 'PDF conversion failed. Try again shortly.';
      try {
        final body = jsonDecode(utf8.decode(bytes));
        if (body is Map &&
            body['error'] is Map &&
            body['error']['message'] is String) {
          message = body['error']['message'] as String;
        }
      } catch (_) {}
      throw FormatException(message);
    }
    if (response.headers.contentType?.mimeType != 'application/epub+zip') {
      throw const FormatException(
        'The PDF service returned an invalid reading edition.',
      );
    }
    sink = output.openWrite();
    var received = 0;
    await for (final chunk in response) {
      received += chunk.length;
      if (received > 128 * 1024 * 1024) {
        throw const FormatException('The converted PDF is too large.');
      }
      sink.add(chunk);
      await sink.flush();
    }
    await sink.close();
    sink = null;
    return output.path;
  } catch (error) {
    await sink?.close();
    await directory.delete(recursive: true);
    if (timedOut) {
      throw const FormatException(
        'PDF conversion timed out. Try a smaller document.',
      );
    }
    if (error is FormatException) rethrow;
    throw const FormatException(
      'PDF imports need a connection to your reading server.',
    );
  } finally {
    timer.cancel();
    client.close(force: true);
  }
}
