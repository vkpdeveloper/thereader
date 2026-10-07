// Output equivalence with another build of the engine (a baseline checkout,
// typically the commit before a performance change), over the eval corpus
// (`test-corpus/parity/`). `write` stores what this build produces; `check`
// compares this build with what `write` stored, byte for byte:
//
//   engine    extractTree(VDocument.fromJson(jsdom tree), url, markdown: true)
//   pipeline  extractHtml(html, url, markdown: true)
//   plain     extractHtml(html, url) (no Markdown)
//   text      articleText of the `plain` article
//   tree      fromDocument(package:html parse) as VDocument JSON
//
//   (in the baseline checkout)  dart run tool/golden.dart write /tmp/golden
//   (in this checkout)          dart run tool/golden.dart check /tmp/golden
//   dart compile exe tool/golden.dart -o /tmp/golden-check && /tmp/golden-check check /tmp/golden   (AOT)
//
// `--modes engine,pipeline` selects modes, `--ids key,key` pages. `engine`
// and `pipeline` are written as `tool/parity.dart --out` writes them, so
// `diff -r` against those dumps works too.
import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

const _modes = ['engine', 'pipeline', 'plain', 'text', 'tree'];

void main(List<String> args) {
  if (args.length < 2 || (args[0] != 'write' && args[0] != 'check')) {
    stderr.writeln('usage: golden.dart write|check <dir> [--modes m,m] [--ids key,key]');
    exitCode = 2;
    return;
  }
  final write = args[0] == 'write';
  final dir = args[1];
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final modes = option('--modes')?.split(',') ?? _modes;
  final ids = option('--ids')?.split(',').toSet();
  final root = '${_findCorpus()}/parity/';
  final manifest = (jsonDecode(File('${root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  const encoder = JsonEncoder.withIndent('  ');
  final same = {for (final m in modes) m: 0};
  final differing = <String>[];
  for (final mode in modes) {
    if (write) Directory('$dir/$mode').createSync(recursive: true);
  }
  for (final page in manifest) {
    final key = page['key'] as String;
    if (ids != null && !ids.contains(key)) continue;
    final url = page['url'] as String;
    final html = File('${root}html/$key.html').readAsStringSync();
    for (final mode in modes) {
      String output;
      try {
        output = switch (mode) {
          'engine' =>
            '${encoder.convert(extractTree(VDocument.fromJson(jsonDecode(File('${root}vdoc/$key.json').readAsStringSync()) as Map<String, dynamic>), url, markdown: true)?.toJson())}\n',
          'pipeline' => '${encoder.convert(extractHtml(html, url, markdown: true)?.toJson())}\n',
          'plain' => '${encoder.convert(extractHtml(html, url)?.toJson())}\n',
          'text' => switch (extractHtml(html, url)) {
            final article? => articleText(article),
            null => '(no article)',
          },
          'tree' => '${encoder.convert(fromDocument(html_parser.parse(html)).toJson())}\n',
          _ => throw ArgumentError('unknown mode $mode'),
        };
      } catch (error) {
        output = 'error: $error';
      }
      final file = File('$dir/$mode/$key.${mode == 'text' ? 'txt' : 'json'}');
      if (write) {
        file.writeAsStringSync(output);
      } else if (file.existsSync() && file.readAsStringSync() == output) {
        same[mode] = same[mode]! + 1;
      } else {
        differing.add('$mode/$key');
      }
    }
  }
  if (write) {
    stdout.writeln('wrote ${modes.join(', ')} to $dir');
    return;
  }
  final mode = const bool.fromEnvironment('dart.vm.product') ? 'AOT' : 'JIT';
  stdout.writeln('golden check ($mode): ${same.entries.map((e) => '${e.key} ${e.value}').join(', ')} identical');
  for (final d in differing) {
    stdout.writeln('  DIFF $d');
  }
  exitCode = differing.isEmpty ? 0 : 1;
}

String _findCorpus() {
  for (var dir = Directory.current.absolute; ; dir = dir.parent) {
    final candidate = Directory('${dir.path}/test-corpus');
    if (candidate.existsSync()) return candidate.path;
    if (dir.parent.path == dir.path) throw StateError('test-corpus/ not found above ${Directory.current.path}');
  }
}
