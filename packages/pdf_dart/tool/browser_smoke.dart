// Compile to JS and load in a browser to exercise the public Dart worker client.
import 'dart:js_interop';
import 'dart:typed_data';
import 'package:pdf_extractor/browser.dart';
import 'package:pdf_extractor/pdf_extractor.dart';

@JS('pdfDartClientSmoke')
external set _smoke(JSFunction value);
void main() {
  _smoke = ((JSArrayBuffer source) {
    return (() async {
      final input = source.toDart.asUint8List(),
          book = await extractInWorker(
            input,
            workerUrl: '/dart-worker.js',
            format: 'epub',
          ).result;
      final document =
          await extractInWorker(input, workerUrl: '/dart-worker.js').result
              as Map;
      final job = extractInWorker(input, workerUrl: '/dart-worker.js');
      job.cancel();
      var cancelled = false;
      try {
        await job.result;
      } on PdfException catch (e) {
        cancelled = e.code == 'ABORTED';
      }
      return {
        'epubBytes': (book as Uint8List).length,
        'epubMagic': book.take(4).toList(),
        'title': document['title'],
        'pages': (document['pages'] as List).length,
        'cancelled': cancelled,
        'inputPreserved': input.length > 0,
      }.jsify();
    })().toJS;
  }).toJS;
}
