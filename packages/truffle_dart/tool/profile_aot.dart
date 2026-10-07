// A load for profiling the AOT build with a native sampler: parses each
// corpus page once, then runs `fromDocument` + `extractTree(markdown: true)`
// on it [reps] times (`--ids key,key` for some pages only). An unstripped AOT
// snapshot is a Mach-O/ELF library with symbols, so macOS `sample` (or
// Instruments, `perf`) names the Dart functions:
//
//   dart compile aot-snapshot tool/profile_aot.dart -o /tmp/profile.aot
//   dartaotruntime /tmp/profile.aot 10 & sleep 2; sample $! 30 -file /tmp/sample.txt
//
// (`dartaotruntime` is in the SDK's `bin/`.) Functions the compiler inlined
// are counted in their callers.
import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

import 'service.dart';

void main(List<String> args) {
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final reps = args.isNotEmpty && !args.first.startsWith('--') ? int.parse(args.first) : 10;
  final ids = option('--ids')?.split(',').toSet();
  final root = '${findCorpus()}/parity/';
  final manifest = (jsonDecode(File('${root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  final watch = Stopwatch()..start();
  var articles = 0;
  for (final page in manifest) {
    if (ids != null && !ids.contains(page['key'])) continue;
    final doc = html_parser.parse(File('${root}html/${page['key']}.html').readAsStringSync());
    for (var r = 0; r < reps; r++) {
      if (extractTree(fromDocument(doc), page['url'] as String, markdown: true) != null) articles++;
    }
  }
  stdout.writeln('$articles articles in ${watch.elapsedMilliseconds} ms');
}
