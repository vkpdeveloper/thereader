// Parity of the Dart port with the TypeScript reference over the eval corpus.
//
// Reads what `packages/truffle/scripts/parity-dump.ts` wrote to
// `test-corpus/parity/` and compares, page by page, with the TypeScript
// `extractTree` output (written with `markdown: true`, so `article.markdown`
// is compared too):
//
//   engine    Dart `extractTree` on the very VDocument jsdom produced (parser
//             differences excluded; the target is 0 differing pages);
//   pipeline  Dart `extractHtml` on the raw HTML (package:html instead of jsdom);
//   tree      the VDocument package:html yields vs the one jsdom yielded
//             (parser differences, whether or not they change the article).
//
//   dart run tool/parity.dart [engine|pipeline] [--ids key,key] [--out dir] [--verbose]
//
// `--out` writes the Dart output per page (2-space JSON) for diffing.
import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

final _root = Directory.fromUri(Platform.script.resolve('../../../test-corpus/parity/')).path;

void main(List<String> args) {
  final mode = args.isNotEmpty && !args.first.startsWith('--') ? args.first : 'engine';
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final ids = option('--ids')?.split(',').toSet();
  final outDir = option('--out');
  final verbose = args.contains('--verbose');
  if (outDir != null) Directory(outDir).createSync(recursive: true);

  final manifest = (jsonDecode(File('${_root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  const encoder = JsonEncoder.withIndent('  ');
  var identical = 0;
  var orderOnly = 0;
  final differing = <String, String>{};
  final failed = <String, String>{};
  for (final page in manifest) {
    final key = page['key'] as String;
    if (ids != null && !ids.contains(key) && !ids.contains(page['id'])) continue;
    final url = page['url'] as String;
    final expectedText = mode == 'tree'
        ? '${encoder.convert(jsonDecode(File('${_root}vdoc/$key.json').readAsStringSync()))}\n'
        : File('${_root}ts/$key.json').readAsStringSync();
    String actualText;
    try {
      final Article? article;
      if (mode == 'tree') {
        final html = File('${_root}html/$key.html').readAsStringSync();
        actualText = '${encoder.convert(fromDocument(html_parser.parse(html)).toJson())}\n';
        if (outDir != null) File('$outDir/$key.json').writeAsStringSync(actualText);
        if (actualText == expectedText) {
          identical++;
        } else {
          differing[key] = firstDifference(jsonDecode(expectedText), jsonDecode(actualText), r'$') ?? 'key order';
        }
        continue;
      } else if (mode == 'engine') {
        final vdoc = VDocument.fromJson(
          jsonDecode(File('${_root}vdoc/$key.json').readAsStringSync()) as Map<String, dynamic>,
        );
        article = extractTree(vdoc, url, markdown: true);
      } else {
        article = extractHtml(File('${_root}html/$key.html').readAsStringSync(), url, markdown: true);
      }
      actualText = '${encoder.convert(article?.toJson())}\n';
    } catch (error, stack) {
      failed[key] = '$error\n$stack';
      continue;
    }
    if (outDir != null) File('$outDir/$key.json').writeAsStringSync(actualText);
    if (actualText == expectedText) {
      identical++;
      continue;
    }
    final expected = jsonDecode(expectedText);
    final actual = jsonDecode(actualText);
    final path = firstDifference(expected, actual, r'$');
    if (path == null) {
      orderOnly++;
    } else {
      differing[key] = path;
    }
  }
  final total = identical + orderOnly + differing.length + failed.length;
  stdout.writeln(
    '$mode parity: $identical/$total byte-identical, $orderOnly differ only in key order, '
    '${differing.length} differ, ${failed.length} failed',
  );
  differing.forEach((key, path) => stdout.writeln('  DIFF $key at $path'));
  failed.forEach((key, error) => stdout.writeln('  FAIL $key: ${verbose ? error : error.split('\n').first}'));
  exitCode = differing.isEmpty && failed.isEmpty ? 0 : 1;
}

/// JSON path of the first difference between two decoded JSON values, with
/// both values; null when they are deeply equal.
String? firstDifference(Object? a, Object? b, String path) {
  if (a is Map && b is Map) {
    for (final key in {...a.keys, ...b.keys}) {
      if (!a.containsKey(key) || !b.containsKey(key)) {
        return '$path.$key (ts: ${_short(a[key])}, dart: ${_short(b[key])})';
      }
      final d = firstDifference(a[key], b[key], '$path.$key');
      if (d != null) return d;
    }
    return null;
  }
  if (a is List && b is List) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      final d = firstDifference(a[i], b[i], '$path[$i]');
      if (d != null) return d;
    }
    return a.length == b.length ? null : '$path length (ts: ${a.length}, dart: ${b.length})';
  }
  if (a == b) return null;
  if (a is String && b is String && (a.length > 160 || b.length > 160)) {
    // Long text (the Markdown): show both around the first differing character.
    var i = 0;
    while (i < a.length && i < b.length && a.codeUnitAt(i) == b.codeUnitAt(i)) {
      i++;
    }
    String around(String s) => s.substring(i < 60 ? 0 : i - 60, i + 100 > s.length ? s.length : i + 100);
    return '$path at $i (ts: ${jsonEncode(around(a))}, dart: ${jsonEncode(around(b))})';
  }
  return '$path (ts: ${_short(a)}, dart: ${_short(b)})';
}

String _short(Object? value) {
  final s = jsonEncode(value);
  return s.length > 160 ? '${s.substring(0, 160)}…' : s;
}
