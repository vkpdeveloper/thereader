import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:path/path.dart' as p;
import 'package:pdf_extractor/pdf_extractor.dart' as pdf;

const maxPdfBytes = 64 * 1024 * 1024;
const _maxResultBytes = 128 * 1024 * 1024;

/// Convert on the device, off the UI isolate. The caller owns the returned
/// temporary EPUB; source PDF bytes never go to an extraction service.
Future<String> convertPdf(
  String sourcePath, {
  Duration timeout = const Duration(seconds: 65),
}) async {
  final size = await File(sourcePath).length();
  if (size == 0 || size > maxPdfBytes) {
    throw const FormatException('PDF imports are limited to 64 MiB.');
  }
  final directory = await Directory.systemTemp.createTemp('thereader-pdf-');
  final output = p.join(directory.path, 'reading-edition.epub');
  final messages = ReceivePort();
  final result = Completer<void>();
  final exited = Completer<void>();
  Isolate? worker;
  final subscription = messages.listen((message) {
    if (message == null) {
      if (!exited.isCompleted) exited.complete();
      if (!result.isCompleted) {
        result.completeError(
          const FormatException('PDF conversion stopped unexpectedly.'),
        );
      }
    } else if (!result.isCompleted) {
      if (message == true) {
        result.complete();
      } else {
        result.completeError(
          FormatException(
            message is String
                ? message
                : 'PDF conversion failed on this device.',
          ),
        );
      }
    }
  });
  var succeeded = false;
  try {
    worker = await Isolate.spawn(
      _convertOnDevice,
      [messages.sendPort, sourcePath, output],
      onError: messages.sendPort,
      onExit: messages.sendPort,
      errorsAreFatal: true,
      debugName: 'pdf-extractor',
    );
    await result.future.timeout(timeout);
    succeeded = true;
    return output;
  } on TimeoutException {
    throw const FormatException(
      'PDF conversion timed out. Try a smaller document.',
    );
  } finally {
    // Wait for termination before deleting a partial file: a late worker write
    // must not recreate or race cleanup after a timeout.
    if (worker != null) {
      worker.kill(priority: Isolate.immediate);
      await exited.future;
    }
    await subscription.cancel();
    messages.close();
    if (!succeeded) await directory.delete(recursive: true);
  }
}

void _convertOnDevice(List<Object?> request) {
  final reply = request[0] as SendPort;
  Object response = true;
  try {
    final input = File(request[1] as String).readAsBytesSync();
    if (input.isEmpty || input.length > maxPdfBytes) {
      throw const FormatException('PDF imports are limited to 64 MiB.');
    }
    final document = pdf.extract(
      input,
      options: const pdf.Options(timeout: Duration(seconds: 60)),
    );
    final book = pdf.epub(document);
    if (book.length > _maxResultBytes) {
      throw const FormatException('The converted PDF is too large.');
    }
    File(request[2] as String).writeAsBytesSync(book, flush: true);
  } on pdf.PdfException catch (error) {
    response = switch (error.code) {
      'ABORTED' => 'PDF conversion timed out. Try a smaller document.',
      'RESOURCE_LIMIT' =>
        'This PDF exceeds the device extraction limits. Try a smaller document.',
      _ => error.message,
    };
  } on FormatException catch (error) {
    response = error.message;
  } catch (_) {
    response = 'PDF conversion failed on this device.';
  }
  Isolate.exit(reply, response);
}
