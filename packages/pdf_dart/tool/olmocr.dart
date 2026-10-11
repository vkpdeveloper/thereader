// Harness only: run from the repository root. Never imports ground truth.
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:pdf_extractor/pdf_extractor.dart';

void main() {
  const local = 'test-corpus/pdf/olmocr';
  final manifest = jsonDecode(
        File('eval/pdf/coverage-v03/olmocr-corpus.json').readAsStringSync(),
      ),
      records = <Map<String, Object?>>[];
  for (final r in manifest['files'] as List) {
    if (!(r['path'] as String).endsWith('.pdf')) continue;
    final path = r['path'] as String,
        relative = path.replaceFirst(RegExp(r'^bench_data/pdfs/'), ''),
        data = File(
          '$local/${path.replaceFirst(RegExp(r'^bench_data/'), '')}',
        ).readAsBytesSync(),
        sha = sha256.convert(data).toString();
    final valid =
        data.length == r['size'] &&
        (r['lfs'] != null
            ? sha == r['lfs']['oid']
            : sha1.convert([
                    ...utf8.encode('blob ${data.length}\u0000'),
                    ...data,
                  ]).toString() ==
                  r['oid']);
    if (!valid) throw StateError('Pinned corpus hash mismatch: $path');
    final target = File(
      '$local/native-dart/${relative.replaceFirst(RegExp(r'\.pdf$'), '_pg1_repeat1.md')}',
    );
    target.parent.createSync(recursive: true);
    final row = <String, Object?>{'pdf': relative, 'sha256': sha},
        start = Stopwatch()..start();
    var markdown = '';
    try {
      final d = extract(
        data,
        options: const Options(timeout: Duration(seconds: 60)),
      );
      markdown = d.markdown;
      row.addAll({
        'version': version,
        'complete': d.complete,
        'stats': d.stats,
        'warnings': d.warnings,
        'needsOCR': d.pages.any((p) => p.needsOCR),
      });
    } catch (e) {
      row['error'] = e.toString();
      if (e is PdfException) row['errorCode'] = e.code;
    }
    target.writeAsStringSync(markdown);
    row['markdownSHA256'] = sha256.convert(utf8.encode(markdown)).toString();
    row['diagnosticWallSeconds'] = start.elapsedMicroseconds / 1e6;
    records.add(row);
    if (records.length % 100 == 0)
      stdout.writeln(
        '${records.length} errors ${records.where((r) => r.containsKey('error')).length}',
      );
  }
  File('eval/pdf/native/olmocr-dart-extraction.json').writeAsStringSync(
    '${const JsonEncoder.withIndent('  ').convert({'datasetRevision': manifest['revision'], 'scope': 'Sequential Dart VM process; diagnostic timings, not browser performance. Original PDF bytes only; no ground truth read by the extractor.', 'documents': records})}\n',
  );
  stdout.writeln(
    'Done ${records.length} errors ${records.where((r) => r.containsKey('error')).length}',
  );
}
