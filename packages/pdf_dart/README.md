# PDF Extractor · Dart

Independent pure Dart PDF → typed blocks → Markdown/EPUB. This package does
not call TypeScript, Go, WebAssembly, PDF.js or an extraction service. Its PDF
syntax, xref, filters, font readers, graphics interpreter and layout algorithms
are implemented here. Compression, JPEG, XML and hashing dependencies are
generic codecs, not PDF extraction libraries.

```dart
import 'package:pdf_extractor/pdf_extractor.dart';
final document = extract(bytes,
  options: const Options(timeout: Duration(seconds: 60)));
print(document.markdown);
print(document.warnings);
final book = epub(document);
```

The core has no `dart:io` dependency. It runs on the Dart VM and compiles to
JavaScript. For a browser, compile and serve the separate worker:

```sh
dart compile js -O2 web/worker.dart -o build/pdf-worker.js
```

```dart
import 'package:pdf_extractor/browser.dart';
final job = extractInWorker(bytes,
  workerUrl: '/pdf-worker.js', format: 'epub');
final result = await job.result; // Uint8List
// job.cancel() terminates extraction immediately.
```

The worker client returns a JSON map for `document` (asset data is base64), a
String for `markdown`, and Uint8List for `epub`. It copies the input before
transfer and terminates the worker after success, error, cancellation or the
outer deadline. The core synchronous API checks its deadline cooperatively;
use a worker to keep the UI responsive and enforce a hard outer deadline.

Limits, structured schema, merged tables, positioned math and cleanup mirror
the Go engine. Positioned math is a visual representation, **not semantic
LaTeX/MathML**. OCR, JPEG2000 and JBIG2 are unsupported. Always expose extraction
warnings; exact parity with Go is not a universal 99% accuracy guarantee.

See [parity and timings](../../eval/pdf/native/README.md). Run `dart test` and
`dart analyze`. The repository uses a Dart workspace; to use a standalone copy,
remove `resolution: workspace` from its pubspec and run `dart pub get`.

Known shared graphics/layout limitations are listed in the [review dispositions](../../eval/pdf/native/review.md).
