// Before/after benchmark of two checkouts of this package (a baseline commit
// and the working tree, typically), with one harness: `tool/bench.dart`,
// `tool/bench_memory.dart` and `tool/service.dart` must be present in both
// (copy them into the baseline's `tool/` if it predates them).
//
//   dart run tool/bench_compare.dart --base ../../../baseline/packages/truffle_dart [--new .]
//     [--rounds 3] [--runs 3] [--rss-pages 8] [--no-alloc] [--out /tmp/truffle-bench]
//
// Builds both harnesses AOT, then alternates the two builds (ABBA order per
// round) so machine load weighs on both alike:
//   time   `bench --runs N` per round; a page's time for a phase is the
//          lowest of its per-round medians.
//   rss    peak RSS of a process extracting the whole corpus (lowest over the
//          rounds), and of one process per page for the largest pages.
//   alloc  `bench_memory alloc` in each checkout (JIT, deterministic, once).
// AOT processes run from the `--new` directory, so both read the same corpus.
// Prints Markdown tables; the raw JSON stays in `--out`.
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final sides = {
    'base': Directory(option('--base') ?? (throw ArgumentError('--base <package dir> is required'))).absolute.path,
    'new': Directory(option('--new') ?? '.').absolute.path,
  };
  final rounds = int.parse(option('--rounds') ?? '3');
  final runs = option('--runs') ?? '3';
  final rssPages = int.parse(option('--rss-pages') ?? '8');
  final out = option('--out') ?? '${Directory.systemTemp.path}/truffle-bench';
  final cwd = sides['new']!;

  for (final MapEntry(key: side, value: dir) in sides.entries) {
    Directory('$out/$side').createSync(recursive: true);
    for (final tool in ['bench', 'bench_memory']) {
      stderr.writeln('compiling $side $tool');
      await _run('dart', ['compile', 'exe', 'tool/$tool.dart', '-o', '$out/$side/$tool'], dir);
    }
  }

  List<String> order(int round) => round.isEven ? ['base', 'new'] : ['new', 'base'];

  final time = {for (final side in sides.keys) side: <Map<String, dynamic>>[]};
  for (var r = 0; r < rounds; r++) {
    for (final side in order(r)) {
      stderr.writeln('time round ${r + 1}/$rounds: $side');
      final file = '$out/$side/time-$r.json';
      await _run('$out/$side/bench', ['--runs', runs, '--json', file], cwd);
      time[side]!.add(jsonDecode(File(file).readAsStringSync()) as Map<String, dynamic>);
    }
  }

  final manifest = (time['new']!.first['pages'] as List).cast<Map<String, dynamic>>();
  final largest = ([...manifest]..sort((a, b) => (b['bytes'] as int).compareTo(a['bytes'] as int)))
      .take(rssPages)
      .map((p) => p['key'] as String)
      .toList();
  final rss = {for (final side in sides.keys) side: <int>[]};
  final pageRss = {
    for (final side in sides.keys) side: {for (final key in largest) key: <int>[]},
  };
  for (var r = 0; r < rounds; r++) {
    for (final side in order(r)) {
      stderr.writeln('rss round ${r + 1}/$rounds: $side');
      final file = '$out/$side/rss-$r.json';
      await _run('$out/$side/bench_memory', ['rss', '--json', file], cwd);
      rss[side]!.add((jsonDecode(File(file).readAsStringSync()) as Map<String, dynamic>)['maxRss'] as int);
      for (final key in largest) {
        await _run('$out/$side/bench_memory', ['rss', '--ids', key, '--json', file], cwd);
        pageRss[side]![key]!.add(
          (jsonDecode(File(file).readAsStringSync()) as Map<String, dynamic>)['pagePeak'] as int,
        );
      }
    }
  }

  final alloc = <String, Map<String, dynamic>>{};
  if (!args.contains('--no-alloc')) {
    for (final MapEntry(key: side, value: dir) in sides.entries) {
      stderr.writeln('alloc: $side');
      final file = '$out/$side/alloc.json';
      await _run('dart', [
        '--enable-vm-service=0',
        '--disable-service-auth-codes',
        'tool/bench_memory.dart',
        'alloc',
        '--json',
        file,
      ], dir);
      alloc[side] = jsonDecode(File(file).readAsStringSync()) as Map<String, dynamic>;
    }
  }

  _report(time, rss, pageRss, alloc, rounds: rounds, runs: runs);
}

Future<void> _run(String executable, List<String> args, String dir) async {
  final result = await Process.run(executable, args, workingDirectory: dir);
  if (result.exitCode != 0) {
    stderr.writeln(result.stdout);
    stderr.writeln(result.stderr);
    throw StateError('$executable ${args.join(' ')} failed in $dir');
  }
}

const _phases = {
  'parse': 'parse (package:html)',
  'convert': '`fromDocument`',
  'engine': '`extractTree`',
  'markdown': '`articleMarkdown`',
  'pipeline': 'parse + `fromDocument` + `extractTree`',
  'full': '`extractHtml(markdown: true)`',
};

const _buckets = [
  ('<50KB', 50000),
  ('50-200KB', 200000),
  ('200-500KB', 500000),
  ('0.5-1MB', 1000000),
  ('>1MB', 1 << 62),
];

void _report(
  Map<String, List<Map<String, dynamic>>> time,
  Map<String, List<int>> rss,
  Map<String, Map<String, List<int>>> pageRss,
  Map<String, Map<String, dynamic>> alloc, {
  required int rounds,
  required String runs,
}) {
  // Per page and phase: the lowest per-round median.
  Map<String, Map<String, double>> best(List<Map<String, dynamic>> runs) {
    final out = <String, Map<String, double>>{};
    for (final run in runs) {
      for (final page in (run['pages'] as List).cast<Map<String, dynamic>>()) {
        final row = out.putIfAbsent(page['key'] as String, () => {'bytes': (page['bytes'] as int).toDouble()});
        final values = {
          for (final phase in ['parse', 'convert', 'engine', 'markdown', 'full'])
            phase: (page[phase] as num).toDouble(),
        };
        values['pipeline'] = values['parse']! + values['convert']! + values['engine']!;
        values.forEach((phase, v) => row.update(phase, (old) => v < old ? v : old, ifAbsent: () => v));
      }
    }
    return out;
  }

  final base = best(time['base']!);
  final next = best(time['new']!);
  final keys = [
    for (final key in next.keys)
      if (base.containsKey(key)) key,
  ];
  List<double> values(Map<String, Map<String, double>> rows, String phase, [Iterable<String>? only]) => [
    for (final key in only ?? keys) rows[key]![phase]!,
  ];

  final first = time['new']!.first;
  stdout.writeln(
    '${first['mode']} time, ${keys.length} pages, $rounds rounds (ABBA) × $runs timed runs per page; '
    'per page the lowest of the round medians. Load at start: ${time['base']!.first['load']}',
  );
  stdout.writeln();
  stdout.writeln(
    '| ms per page | median before → after | p95 before → after | mean before → after | corpus total before → after | speedup (total) |',
  );
  stdout.writeln('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (final MapEntry(key: phase, value: label) in _phases.entries) {
    final b = values(base, phase);
    final n = values(next, phase);
    stdout.writeln(
      '| $label | ${_ms(_median(b))} → ${_ms(_median(n))} | ${_ms(_p95(b))} → ${_ms(_p95(n))} | '
      '${_ms(_mean(b))} → ${_ms(_mean(n))} | ${_ms(_sum(b))} → ${_ms(_sum(n))} | ${(_sum(b) / _sum(n)).toStringAsFixed(2)}x |',
    );
  }
  stdout.writeln();
  stdout.writeln('Per-page speedup (before / after), median / p95 / worst:');
  for (final phase in ['convert', 'engine', 'markdown', 'pipeline', 'full']) {
    final ratios = [for (final key in keys) base[key]![phase]! / next[key]![phase]!]..removeWhere((r) => !r.isFinite);
    ratios.sort();
    stdout.writeln(
      '  ${_phases[phase]}: ${_median(ratios).toStringAsFixed(2)}x / '
      '${_p95(ratios).toStringAsFixed(2)}x / ${ratios.first.toStringAsFixed(2)}x',
    );
  }
  stdout.writeln();

  String bucketOf(String key) => _buckets.firstWhere((b) => next[key]!['bytes']! < b.$2).$1;
  stdout.writeln(
    '| `extractHtml(markdown: true)` ms by HTML size, median before → after | '
    '${_buckets.map((b) => '${b.$1} (${keys.where((k) => bucketOf(k) == b.$1).length})').join(' | ')} |',
  );
  stdout.writeln('| --- |${' ---: |' * _buckets.length}');
  for (final phase in ['convert', 'engine', 'full']) {
    final cells = _buckets.map((b) {
      final only = keys.where((k) => bucketOf(k) == b.$1).toList();
      if (only.isEmpty) return '–';
      return '${_ms(_median(values(base, phase, only)))} → ${_ms(_median(values(next, phase, only)))}';
    });
    stdout.writeln('| ${_phases[phase]} | ${cells.join(' | ')} |');
  }
  stdout.writeln();

  final slowest = [...keys]..sort((a, b) => base[b]!['full']!.compareTo(base[a]!['full']!));
  stdout.writeln('| slowest pages (before) | KB | `extractHtml(markdown: true)` ms before → after | of which parse |');
  stdout.writeln('| --- | ---: | ---: | ---: |');
  for (final key in slowest.take(8)) {
    stdout.writeln(
      '| $key | ${(next[key]!['bytes']! / 1000).round()} | ${_ms(base[key]!['full']!)} → ${_ms(next[key]!['full']!)} | '
      '${_ms(base[key]!['parse']!)} → ${_ms(next[key]!['parse']!)} |',
    );
  }
  stdout.writeln();

  stdout.writeln('| peak RSS (AOT), MB | before | after |');
  stdout.writeln('| --- | ---: | ---: |');
  String mb(num bytes) => (bytes / 1e6).toStringAsFixed(1);
  int low(List<int> v) => v.reduce((a, b) => a < b ? a : b);
  stdout.writeln(
    '| whole corpus, one process (lowest of $rounds) | ${mb(low(rss['base']!))} | ${mb(low(rss['new']!))} |',
  );
  for (final key in pageRss['new']!.keys) {
    stdout.writeln(
      '| $key (${(next[key]?['bytes'] ?? 0) ~/ 1000} KB): page peak over RSS before | '
      '${mb(low(pageRss['base']![key]!))} | ${mb(low(pageRss['new']![key]!))} |',
    );
  }
  stdout.writeln();

  if (alloc.isEmpty) return;
  final allocBase = {
    for (final p in (alloc['base']!['pages'] as List).cast<Map<String, dynamic>>()) p['key'] as String: p,
  };
  final allocNew = {
    for (final p in (alloc['new']!['pages'] as List).cast<Map<String, dynamic>>()) p['key'] as String: p,
  };
  final allocKeys = [
    for (final key in allocNew.keys)
      if (allocBase.containsKey(key)) key,
  ];
  stdout.writeln(
    '| MB per page (JIT) | median before → after | p95 before → after | mean before → after | corpus total before → after |',
  );
  stdout.writeln('| --- | ---: | ---: | ---: | ---: |');
  const allocLabels = {
    'parse': 'allocated: parse (package:html)',
    'convert': 'allocated: `fromDocument`',
    'engine': 'allocated: `extractTree`',
    'markdown': 'allocated: `articleMarkdown`',
    'full': 'allocated: `extractHtml(markdown: true)`',
    'docLive': 'live: package:html `Document`',
    'bothLive': 'live: `Document` + `VDocument` (end of `fromDocument`)',
    'vdocLive': 'live: `VDocument`',
  };
  for (final MapEntry(key: phase, value: label) in allocLabels.entries) {
    List<double> of(Map<String, Map<String, dynamic>> rows) => [
      for (final key in allocKeys) (rows[key]![phase] as int) / 1e6,
    ];
    final b = of(allocBase);
    final n = of(allocNew);
    stdout.writeln(
      '| $label | ${_mb(_median(b))} → ${_mb(_median(n))} | ${_mb(_p95(b))} → ${_mb(_p95(n))} | '
      '${_mb(_mean(b))} → ${_mb(_mean(n))} | ${_sum(b).toStringAsFixed(0)} → ${_sum(n).toStringAsFixed(0)} |',
    );
  }
}

double _median(List<double> values) {
  if (values.isEmpty) return double.nan;
  final sorted = [...values]..sort();
  final mid = sorted.length >> 1;
  return sorted.length.isOdd ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

double _p95(List<double> values) {
  if (values.isEmpty) return double.nan;
  final sorted = [...values]..sort();
  final i = (0.95 * sorted.length).ceil() - 1;
  return sorted[i.clamp(0, sorted.length - 1)];
}

double _sum(List<double> values) => values.fold(0, (a, b) => a + b);

double _mean(List<double> values) => values.isEmpty ? double.nan : _sum(values) / values.length;

String _ms(double value) => value >= 100 ? value.toStringAsFixed(1) : value.toStringAsFixed(2);

String _mb(double value) => value.toStringAsFixed(2);
