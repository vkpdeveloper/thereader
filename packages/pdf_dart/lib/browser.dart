/// Browser worker client. Compile web/worker.dart with `dart compile js` and
/// serve it from your application's origin. The engine itself is pure Dart.
library;

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';
import 'package:web/web.dart' as web;
import 'pdf_extractor.dart';

/// A cancellable job. Cancellation terminates the worker, including tight loops.
class PdfBrowserJob {
  final Future<Object?> result;
  final void Function() cancel;
  PdfBrowserJob._(this.result, this.cancel);
}

/// Returns structured JSON (assets base64), Markdown, or EPUB Uint8List.
/// Input ownership stays with the caller; a copy is transferred to the worker.
PdfBrowserJob extractInWorker(
  Uint8List bytes, {
  required String workerUrl,
  String format = 'document',
  Duration timeout = const Duration(seconds: 65),
  bool keepArtifacts = false,
  Limits limits = const Limits(),
}) {
  if (!['document', 'markdown', 'epub'].contains(format) ||
      timeout <= Duration.zero)
    throw const PdfException(
      'INVALID_REQUEST',
      'Invalid result format or worker deadline',
    );
  if (bytes.length > limits.normalized().inputBytes)
    throw const PdfException(
      'RESOURCE_LIMIT',
      'PDF input exceeds the byte limit.',
    );
  final completer = Completer<Object?>(), worker = web.Worker(workerUrl.toJS);
  Timer? timer;
  void finish([Object? error, Object? value]) {
    if (completer.isCompleted) return;
    timer?.cancel();
    worker.terminate();
    if (error != null) {
      completer.completeError(error);
    } else {
      completer.complete(value);
    }
  }

  void cancel() =>
      finish(const PdfException('ABORTED', 'PDF extraction cancelled'));
  timer = Timer(
    timeout,
    () => finish(
      const PdfException(
        'TIMEOUT',
        'PDF extraction exceeded the worker deadline',
      ),
    ),
  );
  worker.onmessage = ((web.MessageEvent event) {
    try {
      final data = event.data.dartify() as Map;
      if (data['id'] != 1) return;
      final error = data['error'];
      if (error is Map) {
        finish(
          PdfException(error['code'] as String, error['message'] as String),
        );
      } else {
        finish(null, data['result']);
      }
    } catch (e) {
      finish(e);
    }
  }).toJS;
  worker.onerror = ((web.Event event) => finish(
    const PdfException(
      'WORKER_FAILED',
      'The PDF extraction worker could not run.',
    ),
  )).toJS;
  worker.onmessageerror = ((web.Event event) => finish(
    const PdfException(
      'WORKER_FAILED',
      'The PDF extraction result could not be read.',
    ),
  )).toJS;
  try {
    final owned = Uint8List.fromList(bytes).toJS;
    worker.postMessage(
      {
        'id': 1,
        'bytes': _ByteView(owned).buffer,
        'format': format,
        'options': {
          'timeoutMs': timeout.inMilliseconds,
          'keepArtifacts': keepArtifacts,
          'limits': {
            'inputBytes': limits.inputBytes,
            'decodedBytes': limits.decodedBytes,
            'objects': limits.objects,
            'pages': limits.pages,
            'operations': limits.operations,
            'spans': limits.spans,
            'imagePixels': limits.imagePixels,
            'assetBytes': limits.assetBytes,
          },
        },
      }.jsify(),
      [_ByteView(owned).buffer].toJS,
    );
  } catch (e) {
    finish(e);
  }
  return PdfBrowserJob._(completer.future, cancel);
}

extension type _ByteView(JSObject _) implements JSObject {
  external JSArrayBuffer get buffer;
}
