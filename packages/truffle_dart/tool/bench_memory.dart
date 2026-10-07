// Memory use of the pipeline over the eval corpus (`test-corpus/parity/`).
//
//   alloc  Bytes allocated per page, per phase (parse, fromDocument,
//          extractTree, articleMarkdown) and for the whole
//          `extractHtml(html, url, markdown: true)`; and the live heap the
//          trees hold (package:html's `Document`, the `VDocument`, and both
//          at the end of `fromDocument`, the pipeline's peak). JIT, read
//          through the VM service:
//            dart --enable-vm-service=0 --disable-service-auth-codes tool/bench_memory.dart alloc [--json file]
//          A phase's allocation is the growth of the heap's used bytes (new +
//          old space) across it, starting from a just-collected heap, plus
//          what every collection during the phase freed (the `Before`/`After`
//          used sizes of the VM timeline's GC events, in KB). The service
//          exchange adds ~10 KB, measured with nothing in between and
//          subtracted; readings are exact to about 1 KB per collection
//          (checked against allocations of known size). Live sizes are heap used after a full collection,
//          over the heap before the page. Counts are of the JIT's optimized
//          code after a warm-up pass; AOT code allocates the same objects
//          (boxing aside). The VM's allocation profile is no substitute: its
//          accumulated sizes only count objects that survive a scavenge.
//   rss    Peak resident set size (`ProcessInfo.maxRss`) of a process that
//          extracts every page once, as the app would: `extractHtml(html,
//          url, markdown: true)`, the HTML read just before. Run the AOT
//          build. With `--ids key`, one page only: the peak over the RSS just
//          before parsing, which is the page's own peak (heap and VM
//          bookkeeping; the GC's growth policy makes it coarse, ~1 MB).
//            dart compile exe tool/bench_memory.dart -o /tmp/bench-memory
//            /tmp/bench-memory rss [--ids key] [--json file]
import 'dart:convert';
import 'dart:developer';
import 'dart:io';
import 'dart:isolate';

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html_parser;
import 'package:truffle/truffle.dart';

import 'service.dart';

Future<void> main(List<String> args) async {
  String? option(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final mode = args.isNotEmpty && !args.first.startsWith('--') ? args.first : 'alloc';
  final ids = option('--ids')?.split(',').toSet();
  final jsonOut = option('--json');
  final root = '${findCorpus()}/parity/';
  final manifest = [
    for (final page
        in (jsonDecode(File('${root}manifest.json').readAsStringSync()) as List).cast<Map<String, dynamic>>())
      if (ids == null || ids.contains(page['key'])) page,
  ];
  String htmlOf(Map<String, dynamic> page) => File('${root}html/${page['key']}.html').readAsStringSync();

  if (mode == 'rss') {
    final before = ProcessInfo.currentRss;
    var html = '';
    var beforeLast = before;
    for (final page in manifest) {
      html = htmlOf(page);
      beforeLast = ProcessInfo.currentRss;
      extractHtml(html, page['url'] as String, markdown: true);
    }
    final result = {
      'pages': manifest.length,
      'startRss': before,
      'maxRss': ProcessInfo.maxRss,
      if (manifest.length == 1) 'pagePeak': ProcessInfo.maxRss - beforeLast,
    };
    if (jsonOut != null) File(jsonOut).writeAsStringSync(jsonEncode(result));
    stdout.writeln(
      'rss: ${manifest.length} pages, start ${_mb(before)} MB, peak ${_mb(ProcessInfo.maxRss)} MB'
      '${manifest.length == 1 ? ', page peak ${_mb(ProcessInfo.maxRss - beforeLast)} MB' : ''}',
    );
    return;
  }

  final service = await ServiceClient.connect();
  final isolateId = Service.getIsolateId(Isolate.current)!;
  Future<int> used() async {
    final heaps = (await service.call('getIsolate', {'isolateId': isolateId}))['_heaps'] as Map<String, dynamic>;
    return (heaps['new']['used'] as int) + (heaps['old']['used'] as int);
  }

  Future<void> collect() => service.call('getAllocationProfile', {'isolateId': isolateId, 'gc': true});

  await service.call('setVMTimelineFlags', {
    'recordedStreams': ['GC'],
  });
  var collections = 0;
  Future<int> allocated(void Function() phase, [int overhead = 0]) async {
    await collect();
    await service.call('clearVMTimeline');
    final before = await used();
    final from = Timeline.now;
    phase();
    final to = Timeline.now;
    final after = await used();
    // Add back what every collection during the phase freed.
    var freed = 0;
    final timeline = await service.call('getVMTimeline');
    for (final event in (timeline['traceEvents'] as List).cast<Map<String, dynamic>>()) {
      final args = event['args'] as Map<String, dynamic>?;
      final ts = event['ts'] as int?;
      if (args == null || ts == null || ts < from || ts > to || args['Before.Old.Used (kB)'] == null) continue;
      int kb(String key) => int.parse(args[key] as String) * 1024;
      final delta =
          kb('Before.New.Used (kB)') +
          kb('Before.Old.Used (kB)') -
          kb('After.New.Used (kB)') -
          kb('After.Old.Used (kB)');
      if (delta != 0) collections++;
      freed += delta;
    }
    return after - before + freed - overhead;
  }

  Future<int> live() async {
    final profile = await service.call('getAllocationProfile', {'isolateId': isolateId, 'gc': true});
    var bytes = 0;
    for (final member in (profile['members'] as List).cast<Map<String, dynamic>>()) {
      bytes += member['bytesCurrent'] as int? ?? 0;
    }
    return bytes;
  }

  // Warm up: compile and optimize everything the measured calls run.
  for (final page in manifest) {
    extractHtml(htmlOf(page), page['url'] as String, markdown: true);
  }
  final empty = [for (var i = 0; i < 9; i++) await allocated(() {})]..sort();
  final overhead = empty[empty.length >> 1];

  final rows = <Map<String, Object>>[];
  for (final page in manifest) {
    final html = htmlOf(page);
    final url = page['url'] as String;
    dom.Document? doc;
    VDocument? vdoc;
    Article? article;
    final base = await live();
    final parse = await allocated(() => doc = html_parser.parse(html), overhead);
    final docLive = await live() - base;
    final convert = await allocated(() => vdoc = fromDocument(doc!), overhead);
    final bothLive = await live() - base;
    doc = null;
    final vdocLive = await live() - base;
    final engine = await allocated(() => article = extractTree(vdoc!, url), overhead);
    vdoc = null;
    final markdown = await allocated(() {
      if (article != null) articleMarkdown(article!);
    }, overhead);
    article = null;
    final full = await allocated(() => extractHtml(html, url, markdown: true), overhead);
    rows.add({
      'key': page['key'] as String,
      'bytes': page['bytes'] as int,
      'parse': parse,
      'convert': convert,
      'engine': engine,
      'markdown': markdown,
      'full': full,
      'docLive': docLive,
      'bothLive': bothLive,
      'vdocLive': vdocLive,
    });
  }
  await service.close();

  if (jsonOut != null) {
    File(jsonOut).writeAsStringSync(jsonEncode({'overhead': overhead, 'collections': collections, 'pages': rows}));
  }
  stdout.writeln(
    'Bytes allocated per page (JIT), ${rows.length} pages; service overhead ${empty.first}-${empty.last} bytes, '
    '$overhead subtracted; $collections collections during measured phases added back',
  );
  stdout.writeln();
  stdout.writeln('| MB per page | median | p95 | mean | corpus total |');
  stdout.writeln('| --- | ---: | ---: | ---: | ---: |');
  for (final phase in _labels.keys) {
    final values = [for (final r in rows) (r[phase] as int) / 1e6]..sort();
    final total = values.fold<double>(0, (a, b) => a + b);
    stdout.writeln(
      '| ${_labels[phase]} | ${values[values.length >> 1].toStringAsFixed(2)} | '
      '${values[((0.95 * values.length).ceil() - 1).clamp(0, values.length - 1)].toStringAsFixed(2)} | '
      '${(total / values.length).toStringAsFixed(2)} | ${total.toStringAsFixed(0)} |',
    );
  }
}

const _labels = {
  'parse': 'allocated: parse (package:html)',
  'convert': 'allocated: `fromDocument`',
  'engine': 'allocated: `extractTree`',
  'markdown': 'allocated: `articleMarkdown`',
  'full': 'allocated: `extractHtml(markdown: true)`',
  'docLive': 'live: package:html `Document`',
  'bothLive': 'live: `Document` + `VDocument` (end of `fromDocument`)',
  'vdocLive': 'live: `VDocument`',
};

String _mb(int bytes) => (bytes / 1e6).toStringAsFixed(1);
