// The `ours-dart` engine of the eval harness (`eval/scripts/eval.ts`): runs
// the Dart port over a batch of pages in one process, the way the app runs it
// (package:html parse, then fromDocument + extractTree), and times parse and
// extraction separately inside Dart. The harness compiles it with
// `dart compile exe` and summarizes the returned articles exactly as it does
// the TypeScript engine's.
//
//   eval_cli <manifest.json> <out.json> [--runs 5] [--slow-ms 5000]
//
// The manifest is `[{id, path, url}]` (decoded HTML files). Per page: one
// warm-up run whose article is returned, then `--runs` timed runs; a warm-up
// slower than `--slow-ms` becomes the only timing sample. As the harness does
// for the Chromium engines, a page without `<base href>` gets one with its URL
// (part of the timed parse).
import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:thereader_extract/thereader_extract.dart';

void main(List<String> args) {
  if (args.length < 2) {
    stderr.writeln('usage: eval_cli <manifest.json> <out.json> [--runs 5] [--slow-ms 5000]');
    exit(64);
  }
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final runs = int.parse(option('--runs') ?? '5');
  final slowMs = double.parse(option('--slow-ms') ?? '5000');
  final manifest = (jsonDecode(File(args[0]).readAsStringSync()) as List).cast<Map<String, dynamic>>();
  final results = <String, Object?>{};
  final watch = Stopwatch()..start();
  for (final entry in manifest) {
    final id = entry['id'] as String;
    final url = entry['url'] as String;
    final parseMs = <double>[];
    final extractMs = <double>[];
    try {
      final html = File(entry['path'] as String).readAsStringSync();
      Map<String, Object?>? article;
      for (var i = 0; i <= runs; i++) {
        final t0 = watch.elapsedMicroseconds;
        final doc = html_parser.parse(html);
        final hasBase = doc.querySelector('base[href]') != null;
        final t1 = watch.elapsedMicroseconds;
        final output = extractTree(_withBase(fromDocument(doc), hasBase ? null : url), url);
        final t2 = watch.elapsedMicroseconds;
        if (i == 0) article = output?.toJson();
        final slow = (t2 - t0) / 1000 > slowMs;
        if (i > 0 || slow) {
          parseMs.add((t1 - t0) / 1000);
          extractMs.add((t2 - t1) / 1000);
        }
        if (slow) break;
      }
      results[id] = {'ok': true, 'article': article, 'parseMs': parseMs, 'extractMs': extractMs};
    } catch (error) {
      results[id] = {'ok': false, 'error': '$error', 'parseMs': <double>[], 'extractMs': <double>[]};
    }
  }
  File(args[1]).writeAsStringSync(
    jsonEncode({
      'version': Platform.version.split(' ').first,
      'mode': const bool.fromEnvironment('dart.vm.product') ? 'AOT' : 'JIT',
      'results': results,
    }),
  );
}

/// [doc] with [baseHref] as its first `<base href>`, as if one were prepended to `<head>`.
VDocument _withBase(VDocument doc, String? baseHref) => baseHref == null
    ? doc
    : VDocument(
        root: doc.root,
        head: doc.head,
        body: doc.body,
        jsonLd: doc.jsonLd,
        nextData: doc.nextData,
        baseHref: baseHref,
      );
