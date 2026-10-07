// CPU profile of the pipeline over the eval corpus, from the VM's sampling
// profiler (JIT), read through the VM service protocol with no package
// dependency. Prints the functions with the most samples, by self time and
// by inclusive time.
//
//   dart --enable-vm-service=0 --disable-service-auth-codes --profiler --profile-period=100 \
//     [--interpret_irregexp] tool/profile.dart [--runs 3] [--ids key,key] [--phase all|parse|convert|extract|markdown]
//
// `--interpret_irregexp` runs regular expressions as AOT builds do
// (interpreted); without it the JIT compiles them to machine code.
import 'dart:convert';
import 'dart:developer';
import 'dart:io';
import 'dart:isolate';

import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

import 'service.dart';

Future<void> main(List<String> args) async {
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final runs = int.parse(option('--runs') ?? '3');
  final ids = option('--ids')?.split(',').toSet();
  final phase = option('--phase') ?? 'all';
  final top = int.parse(option('--top') ?? '60');
  final service = await ServiceClient.connect();
  final isolateId = Service.getIsolateId(Isolate.current)!;

  final root = '${findCorpus()}/parity/';
  final manifest = (jsonDecode(File('${root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  final pages = [
    for (final page in manifest)
      if (ids == null || ids.contains(page['key']))
        (html: File('${root}html/${page['key']}.html').readAsStringSync(), url: page['url'] as String),
  ];

  // Warm up (JIT compilation), then sample.
  for (final page in pages) {
    extractHtml(page.html, page.url, markdown: true);
  }
  await service.call('clearCpuSamples', {'isolateId': isolateId});
  final self = <String, int>{};
  final inclusive = <String, int>{};
  var total = 0;
  for (var r = 0; r < runs; r++) {
    for (var p = 0; p < pages.length; p++) {
      final page = pages[p];
      switch (phase) {
        case 'parse':
          html_parser.parse(page.html);
        case 'convert':
          fromDocument(html_parser.parse(page.html));
        case 'extract':
          extractTree(fromDocument(html_parser.parse(page.html)), page.url);
        default:
          extractHtml(page.html, page.url, markdown: true);
      }
      // Drain the sample buffer often enough that it never wraps.
      if (p % 20 == 19 || p == pages.length - 1) {
        final samples = await service.call('getCpuSamples', {
          'isolateId': isolateId,
          'timeOriginMicros': 0,
          'timeExtentMicros': 1 << 62,
        });
        await service.call('clearCpuSamples', {'isolateId': isolateId});
        final functions = [
          for (final f in samples['functions'] as List)
            _name((f as Map<String, dynamic>)['function'] as Map<String, dynamic>),
        ];
        for (final s in (samples['samples'] as List).cast<Map<String, dynamic>>()) {
          final stack = (s['stack'] as List).cast<int>();
          if (stack.isEmpty) continue;
          total++;
          self.update(functions[stack.first], (n) => n + 1, ifAbsent: () => 1);
          for (final name in {for (final i in stack) functions[i]}) {
            inclusive.update(name, (n) => n + 1, ifAbsent: () => 1);
          }
        }
      }
    }
  }
  await service.close();

  void table(String title, Map<String, int> counts) {
    stdout.writeln('$title ($total samples)');
    final sorted = counts.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    for (final e in sorted.take(top)) {
      stdout.writeln('  ${(100 * e.value / total).toStringAsFixed(1).padLeft(5)}%  ${e.key}');
    }
    stdout.writeln();
  }

  table('Self', self);
  table('Inclusive', inclusive);
}

String _name(Map<String, dynamic> function) {
  final name = function['name'] as String? ?? '?';
  final owner = function['owner'];
  if (owner is Map<String, dynamic>) {
    final ownerName = owner['name'] as String? ?? '';
    final uri = (owner['location'] as Map<String, dynamic>?)?['script']?['uri'] as String? ?? owner['uri'] as String?;
    if (owner['type'] == '@Function' || owner['type'] == 'Function') return '${_name(owner)}.$name';
    final file = uri == null ? '' : ' (${uri.split('/').last})';
    return owner['type'] == '@Class' ? '$ownerName.$name$file' : '$name$file';
  }
  return name;
}
