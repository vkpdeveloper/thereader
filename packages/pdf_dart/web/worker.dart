import 'dart:convert';
import 'dart:js_interop';
import 'package:web/web.dart' as web;
import 'package:pdf_extractor/pdf_extractor.dart';

@JS('self')
external web.DedicatedWorkerGlobalScope get _self;
extension type _Request(JSObject _) implements JSObject {
  external JSAny? get id;
  external JSArrayBuffer get bytes;
  external JSString get format;
  external JSObject? get options;
}
void main() {
  _self.onmessage = ((web.MessageEvent event) {
    JSAny? id;
    try {
      final request = _Request(event.data as JSObject);
      id = request.id;
      final format = request.format.toDart;
      if (!['document', 'markdown', 'epub'].contains(format))
        throw const PdfException(
          'INVALID_REQUEST',
          'Expected PDF bytes and a result format.',
        );
      final opts = request.options?.dartify() as Map? ?? {},
          l = opts['limits'] as Map? ?? {};
      int value(String key, int fallback) =>
          l[key] is num ? (l[key] as num).toInt() : fallback;
      final limits = Limits(
        inputBytes: value('inputBytes', 64 * 1048576),
        decodedBytes: value('decodedBytes', 256 * 1048576),
        objects: value('objects', 200000),
        pages: value('pages', 10000),
        operations: value('operations', 5000000),
        spans: value('spans', 2000000),
        imagePixels: value('imagePixels', 20000000),
        assetBytes: value('assetBytes', 128 * 1048576),
      );
      final timeout = opts['timeoutMs'] is num
          ? (opts['timeoutMs'] as num).toInt()
          : 65000;
      final doc = extract(
        request.bytes.toDart.asUint8List(),
        options: Options(
          limits: limits,
          keepArtifacts: opts['keepArtifacts'] == true,
          timeout: Duration(milliseconds: timeout),
        ),
      );
      final result = <String, Object?>{
        'id': id?.dartify(),
        'stats': doc.stats.toJson(),
        'warnings': doc.warnings.map((w) => w.toJson()).toList(),
        'complete': doc.complete,
      };
      if (format == 'epub') {
        final bytes = epub(doc);
        final jsBytes = bytes.toJS;
        result['result'] = jsBytes;
        _self.postMessage(result.jsify(), [_ByteView(jsBytes).buffer].toJS);
      } else {
        result['result'] = format == 'markdown'
            ? doc.markdown
            : jsonDecode(jsonEncode(doc));
        _self.postMessage(result.jsify());
      }
    } catch (e) {
      _self.postMessage(
        {
          'id': id?.dartify(),
          'error': {
            'code': e is PdfException ? e.code : 'EXTRACTION_FAILED',
            'message': e is PdfException ? e.message : e.toString(),
          },
        }.jsify(),
      );
    }
  }).toJS;
}

extension type _ByteView(JSObject _) implements JSObject {
  external JSArrayBuffer get buffer;
}
