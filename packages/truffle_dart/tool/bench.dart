// Speed of the Dart port over the eval corpus (`test-corpus/parity/`, written
// by `packages/truffle/scripts/parity-dump.ts`), next to the TypeScript engine
// on the same pages: Chromium (`test-corpus/eval-out/*/ours.json`, parse with
// the native DOMParser, extract = fromDom + extractTree) and Bun (`tsMs` in the
// parity manifest: extractTree alone on the jsdom tree).
//
//   dart run tool/bench.dart [--runs 5] [--ids key,key]              (JIT)
//   dart compile exe tool/bench.dart -o /tmp/bench && /tmp/bench     (AOT)
//
// Per page: one warm-up run, then `--runs` timed runs; each phase is the
// median of its runs. Summaries are over the per-page medians. `articleMarkdown`
// (what `markdown: true` adds) is timed on its own and left out of the totals;
// `extractHtml(html, url, markdown: true)`, the whole pipeline as the app runs
// it, is timed in a separate call. `--json file` also writes the per-page
// medians and the process's peak RSS, which `tool/bench_compare.dart` and
// `eval/scripts/bench.ts` (TypeScript, Dart and Go side by side) read.
import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

void main(List<String> args) {
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final runs = int.parse(option('--runs') ?? '5');
  final ids = option('--ids')?.split(',').toSet();
  final jsonOut = option('--json');
  final corpus = _findCorpus();
  final root = '$corpus/parity/';
  final manifest = (jsonDecode(File('${root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  final chromium = _chromiumTimings(corpus);

  final rows = <_Row>[];
  final watch = Stopwatch()..start();
  for (final page in manifest) {
    final key = page['key'] as String;
    if (ids != null && !ids.contains(key)) continue;
    final html = File('${root}html/$key.html').readAsStringSync();
    final url = page['url'] as String;
    final parse = <double>[];
    final convert = <double>[];
    final engine = <double>[];
    final markdown = <double>[];
    final full = <double>[];
    for (var r = 0; r <= runs; r++) {
      final t0 = watch.elapsedMicroseconds;
      final doc = html_parser.parse(html);
      final t1 = watch.elapsedMicroseconds;
      final vdoc = fromDocument(doc);
      final t2 = watch.elapsedMicroseconds;
      final article = extractTree(vdoc, url);
      final t3 = watch.elapsedMicroseconds;
      if (article != null) articleMarkdown(article);
      final t4 = watch.elapsedMicroseconds;
      extractHtml(html, url, markdown: true);
      final t5 = watch.elapsedMicroseconds;
      if (r == 0) continue;
      parse.add((t1 - t0) / 1000);
      convert.add((t2 - t1) / 1000);
      engine.add((t3 - t2) / 1000);
      markdown.add((t4 - t3) / 1000);
      full.add((t5 - t4) / 1000);
    }
    rows.add(
      _Row(
        key: key,
        bytes: page['bytes'] as int,
        parse: _median(parse),
        convert: _median(convert),
        engine: _median(engine),
        markdown: _median(markdown),
        full: _median(full),
        tsBun: (page['tsMs'] as num).toDouble(),
        chromium: chromium[key],
      ),
    );
  }

  final mode = const bool.fromEnvironment('dart.vm.product') ? 'AOT' : 'JIT';
  if (jsonOut != null) {
    File(jsonOut).writeAsStringSync(
      jsonEncode({
        'mode': mode,
        'version': Platform.version.split(' ').first,
        'runs': runs,
        'load': _loadAverage(),
        'maxRss': ProcessInfo.maxRss,
        'pages': [
          for (final r in rows)
            {
              'key': r.key,
              'bytes': r.bytes,
              'parse': r.parse,
              'convert': r.convert,
              'engine': r.engine,
              'markdown': r.markdown,
              'full': r.full,
            },
        ],
      }),
    );
  }
  stdout.writeln(
    'Dart $mode (${Platform.version.split(' ').first}), ${rows.length} pages, $runs timed runs per page, '
    'load ${_loadAverage()}',
  );
  stdout.writeln();
  stdout.writeln('| ms per page | median | p95 | mean |');
  stdout.writeln('| --- | ---: | ---: | ---: |');
  void line(String label, Iterable<double> values) {
    final v = values.toList();
    stdout.writeln('| $label | ${_ms(_median(v))} | ${_ms(_p95(v))} | ${_ms(_mean(v))} |');
  }

  line('Dart parse (package:html)', rows.map((r) => r.parse));
  line('Dart fromDocument', rows.map((r) => r.convert));
  line('Dart extractTree', rows.map((r) => r.engine));
  line('Dart extract (fromDocument + extractTree)', rows.map((r) => r.convert + r.engine));
  line('Dart total', rows.map((r) => r.total));
  line('Dart articleMarkdown (not in the totals)', rows.map((r) => r.markdown));
  line('Dart extractHtml(markdown: true), separate call', rows.map((r) => r.full));
  final withChromium = rows.where((r) => r.chromium != null).toList();
  line('TS Chromium parse (DOMParser)', withChromium.map((r) => r.chromium!.parse));
  line('TS Chromium extract (fromDom + extractTree)', withChromium.map((r) => r.chromium!.extract));
  line('TS Chromium total', withChromium.map((r) => r.chromium!.parse + r.chromium!.extract));
  line('TS Bun extractTree', rows.map((r) => r.tsBun));
  stdout.writeln();
  stdout.writeln('Ratios, per page (Dart / TS), median / p95:');
  void ratio(String label, Iterable<double> values) {
    final v = values.where((x) => x.isFinite).toList();
    stdout.writeln('  $label: ${_median(v).toStringAsFixed(2)}x / ${_p95(v).toStringAsFixed(2)}x');
  }

  ratio('extract vs Chromium extract', withChromium.map((r) => (r.convert + r.engine) / r.chromium!.extract));
  ratio('total vs Chromium total', withChromium.map((r) => r.total / (r.chromium!.parse + r.chromium!.extract)));
  ratio('extractTree vs Bun extractTree', rows.map((r) => r.engine / r.tsBun));
  stdout.writeln('Markdown cost, per page (articleMarkdown / extractTree), median / p95:');
  ratio('articleMarkdown vs extractTree', rows.where((r) => r.engine > 0).map((r) => r.markdown / r.engine));
  stdout.writeln();
  stdout.writeln(
    '| total ms by HTML size (median / p95) | ${_buckets.map((b) => '${b.$1} (${rows.where((r) => _bucket(r.bytes) == b.$1).length})').join(' | ')} |',
  );
  stdout.writeln('| --- |${' ---: |' * _buckets.length}');
  String bucketCells(double Function(_Row) value, [Iterable<_Row>? source]) => _buckets
      .map((b) {
        final v = (source ?? rows).where((r) => _bucket(r.bytes) == b.$1).map(value).toList();
        return v.isEmpty ? '–' : '${_ms(_median(v))} / ${_ms(_p95(v))}';
      })
      .join(' | ');
  stdout.writeln('| Dart parse | ${bucketCells((r) => r.parse)} |');
  stdout.writeln('| Dart extract | ${bucketCells((r) => r.convert + r.engine)} |');
  stdout.writeln('| Dart total | ${bucketCells((r) => r.total)} |');
  stdout.writeln(
    '| TS Chromium total | ${bucketCells((r) => r.chromium!.parse + r.chromium!.extract, withChromium)} |',
  );
  stdout.writeln('| TS Bun extractTree | ${bucketCells((r) => r.tsBun)} |');
  final slowest = [...rows]..sort((a, b) => b.total.compareTo(a.total));
  stdout.writeln();
  stdout.writeln('Slowest pages (Dart total ms: parse + fromDocument + extractTree):');
  for (final r in slowest.take(8)) {
    stdout.writeln(
      '  ${_ms(r.total)}  (${_ms(r.parse)} + ${_ms(r.convert)} + ${_ms(r.engine)})  '
      '${(r.bytes / 1000).round()} KB  ${r.key}',
    );
  }
}

class _Row {
  _Row({
    required this.key,
    required this.bytes,
    required this.parse,
    required this.convert,
    required this.engine,
    required this.markdown,
    required this.full,
    required this.tsBun,
    required this.chromium,
  });

  final String key;
  final int bytes;
  final double parse;
  final double convert;
  final double engine;
  final double markdown;
  final double full;
  final double tsBun;
  final ({double parse, double extract})? chromium;

  double get total => parse + convert + engine;
}

const _buckets = [
  ('<50KB', 50000),
  ('50-200KB', 200000),
  ('200-500KB', 500000),
  ('0.5-1MB', 1000000),
  ('>1MB', 1 << 62),
];

String _bucket(int bytes) => _buckets.firstWhere((b) => bytes < b.$2).$1;

/// Per-page TS timings from the last Chromium eval run, keyed like the parity manifest.
Map<String, ({double parse, double extract})> _chromiumTimings(String corpus) {
  final out = <String, ({double parse, double extract})>{};
  for (final dataset in ['zyte', 'curated']) {
    final file = File('$corpus/eval-out/$dataset/ours.json');
    if (!file.existsSync()) continue;
    final data = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    for (final doc in (data['docs'] as List).cast<Map<String, dynamic>>()) {
      final parse = doc['parseMs'] as num?;
      final extract = doc['extractMs'] as num?;
      if (parse == null || extract == null) continue;
      out['$dataset-${doc['id']}'] = (parse: parse.toDouble(), extract: extract.toDouble());
    }
  }
  return out;
}

String _findCorpus() {
  for (var dir = Directory.current.absolute; ; dir = dir.parent) {
    final candidate = Directory('${dir.path}/test-corpus');
    if (candidate.existsSync()) return candidate.path;
    if (dir.parent.path == dir.path) throw StateError('test-corpus/ not found above ${Directory.current.path}');
  }
}

String _loadAverage() {
  try {
    final result = Process.runSync('sysctl', ['-n', 'vm.loadavg']);
    return (result.stdout as String).trim();
  } catch (_) {
    return 'n/a';
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

double _mean(List<double> values) => values.isEmpty ? double.nan : values.reduce((a, b) => a + b) / values.length;

String _ms(double value) => value >= 100 ? value.toStringAsFixed(1) : value.toStringAsFixed(2);
