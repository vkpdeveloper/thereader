// Shared pieces of the screen-recording tests: the event log a host script
// reads (and cuts clips by), a log of every HTTP request the app makes, human
// typing, and a guided read through an open article that stops on its code,
// math, tables, figures, details and footnotes.
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:super_sliver_list/super_sliver_list.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/features/articles/article_blocks.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/features/articles/article_style.dart';
import 'package:truffle/truffle.dart';

const recordDir = String.fromEnvironment('THEREADER_RECORD_DIR');

/// Stops per article on the guided read.
const tourStops = int.fromEnvironment('THEREADER_RECORD_STOPS', defaultValue: 4);

final _clock = Stopwatch()..start();
int get elapsedMs => _clock.elapsedMilliseconds;

/// Logs [line] with the test's clock and the wall clock (epoch ms), which the
/// host script lines up with the video to cut per-article clips.
void event(String line) {
  debugPrint('[recording] $line');
  if (recordDir.isNotEmpty) {
    File('$recordDir/events.txt').writeAsStringSync(
      '${_clock.elapsedMilliseconds}ms @${DateTime.now().millisecondsSinceEpoch} $line\n',
      mode: FileMode.append,
    );
  }
}

Future<void> hold(WidgetTester tester, int ms) => tester.pump(Duration(milliseconds: ms));

/// Writes `<dir>/ready` and waits for the host to start the recorder.
Future<void> waitForRecorder(WidgetTester tester) async {
  if (recordDir.isEmpty) return;
  File('$recordDir/ready').writeAsStringSync('${DateTime.now().toIso8601String()}\n');
  for (var i = 0; i < 80 && !File('$recordDir/recording').existsSync(); i++) {
    await hold(tester, 100);
  }
}

/// Types [text] into the focused field a couple of characters at a time.
Future<void> typeLikeAPerson(WidgetTester tester, Finder field, String text) async {
  for (var n = 1; n <= text.length; n += 2) {
    tester.testTextInput.enterText(text.substring(0, n.clamp(0, text.length)));
    await hold(tester, 35);
  }
  await tester.enterText(field, text);
}

/// Every request the app opens, appended to `<dir>/http.txt` as
/// `<epoch ms> <METHOD> <url>`, so a run can show which hosts it talked to.
class RequestLog extends HttpOverrides {
  final List<(int, String, Uri)> requests = [];

  @override
  HttpClient createHttpClient(SecurityContext? context) => _LoggingClient(super.createHttpClient(context), _log);

  void _log(String method, Uri url) {
    final at = DateTime.now().millisecondsSinceEpoch;
    requests.add((at, method, url));
    if (recordDir.isNotEmpty) {
      File('$recordDir/http.txt').writeAsStringSync('$at $method $url\n', mode: FileMode.append);
    }
  }

  /// Requests since [sinceMs] (epoch) whose URL matches [test].
  Iterable<Uri> where(int sinceMs, bool Function(Uri) test) =>
      requests.where((r) => r.$1 >= sinceMs && test(r.$3)).map((r) => r.$3);
}

class _LoggingClient implements HttpClient {
  _LoggingClient(this._inner, this._log);

  final HttpClient _inner;
  final void Function(String, Uri) _log;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) {
    _log(method, url);
    return _inner.openUrl(method, url);
  }

  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) =>
      openUrl(method, Uri(scheme: 'http', host: host, port: port, path: path));
  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);
  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('POST', url);
  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('PUT', url);
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => openUrl('DELETE', url);
  @override
  Future<HttpClientRequest> headUrl(Uri url) => openUrl('HEAD', url);
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => openUrl('PATCH', url);
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => open('GET', host, port, path);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => open('POST', host, port, path);
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => open('PUT', host, port, path);
  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => open('DELETE', host, port, path);
  @override
  Future<HttpClientRequest> head(String host, int port, String path) => open('HEAD', host, port, path);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => open('PATCH', host, port, path);

  @override
  bool get autoUncompress => _inner.autoUncompress;
  @override
  set autoUncompress(bool value) => _inner.autoUncompress = value;
  @override
  Duration? get connectionTimeout => _inner.connectionTimeout;
  @override
  set connectionTimeout(Duration? value) => _inner.connectionTimeout = value;
  @override
  Duration get idleTimeout => _inner.idleTimeout;
  @override
  set idleTimeout(Duration value) => _inner.idleTimeout = value;
  @override
  int? get maxConnectionsPerHost => _inner.maxConnectionsPerHost;
  @override
  set maxConnectionsPerHost(int? value) => _inner.maxConnectionsPerHost = value;
  @override
  String? get userAgent => _inner.userAgent;
  @override
  set userAgent(String? value) => _inner.userAgent = value;
  @override
  set findProxy(String Function(Uri url)? f) => _inner.findProxy = f;
  @override
  set badCertificateCallback(bool Function(X509Certificate cert, String host, int port)? callback) =>
      _inner.badCertificateCallback = callback;
  @override
  void close({bool force = false}) => _inner.close(force: force);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// One place the guided read pauses.
class _Stop {
  _Stop(this.index, this.kind, [this.footnote]);

  final int index;
  final String kind;
  final String? footnote;
}

bool _hasMath(List<Inline> content) => content.any((i) => i is InlineMath);

String? _footnoteIn(List<Inline> content, Set<String> notes) {
  for (final i in content) {
    if (i is FootnoteRef && notes.contains(i.id) && RegExp(r'^\d+$').hasMatch(i.label)) return i.id;
  }
  return null;
}

/// Picks up to [count] stops: the first of each kind of interesting block
/// (in this order of preference), plus, in a very long article, one deep in
/// it; a photo gallery stops on pictures spread through it.
List<_Stop> _pickStops(List<Block> blocks, int count) {
  final notes = {
    for (final b in blocks)
      if (b case FootnotesBlock(:final items)) ...items.map((n) => n.id),
  };
  final byKind = <String, List<int>>{};
  final refs = <int, String>{};
  for (var i = 1; i < blocks.length; i++) {
    final kind = switch (blocks[i]) {
      CodeBlock() => 'code',
      MathBlock() => 'math',
      ParagraphBlock(:final content) when _hasMath(content) => 'math',
      TableBlock() => 'table',
      FigureBlock(:final images) when images.isNotEmpty => 'figure',
      DetailsBlock() => 'details',
      DefinitionListBlock() => 'definitions',
      CalloutBlock() => 'callout',
      QuoteBlock() => 'quote',
      _ => null,
    };
    if (kind != null) byKind.putIfAbsent(kind, () => []).add(i);
    if (blocks[i] case ParagraphBlock(:final content)) {
      final id = _footnoteIn(content, notes);
      if (id != null && !refs.containsValue(id)) refs[i] = id;
    }
  }
  final figures = byKind['figure'] ?? const [];
  final others = byKind.entries.where((e) => e.key != 'figure').fold(0, (n, e) => n + e.value.length);
  if (figures.length >= 8 && others < figures.length ~/ 4) {
    return [
      for (var k = 0; k < count; k++) _Stop(figures[((k + 0.5) * figures.length / count).floor()], 'figure'),
    ];
  }
  const order = ['code', 'math', 'table', 'figure', 'footnote', 'details', 'definitions', 'callout', 'quote'];
  final picked = <_Stop>[];
  for (final kind in order) {
    if (picked.length >= count) break;
    if (kind == 'footnote') {
      if (refs.isNotEmpty) picked.add(_Stop(refs.keys.first, 'footnote', refs.values.first));
      continue;
    }
    final at = byKind[kind];
    if (at != null) picked.add(_Stop(at.first, kind));
  }
  if (blocks.length > 400 && picked.isNotEmpty) {
    // Show how far the document goes: the same kind of block much later on.
    final kind = picked.first.kind;
    final deep = (byKind[kind] ?? const <int>[]).where((i) => i > blocks.length * 0.6).firstOrNull;
    if (deep != null) {
      if (picked.length >= count) picked.removeLast();
      picked.add(_Stop(deep, kind));
    }
  }
  return picked..sort((a, b) => a.index.compareTo(b.index));
}

/// Reads the open article like a person: the opening screens at reading
/// pace, then smooth scrolls to a few interesting blocks with a pause on
/// each (sliding a wide table or code block sideways, opening a details
/// block, jumping to a footnote and back).
Future<void> readArticle(WidgetTester tester, String label) async {
  final screen = find.byType(ArticleScreen);
  final summary = tester.widget<ArticleScreen>(screen).summary;
  final article = await AppScope.of(tester.element(screen)).articles!.loadArticle(summary.id);
  final list = tester.widget<SuperSliverList>(find.descendant(of: screen, matching: find.byType(SuperSliverList))).listController!;
  final scroll = tester.widget<CustomScrollView>(find.descendant(of: screen, matching: find.byType(CustomScrollView))).controller!;
  final position = scroll.position;

  Future<void> step(double screens, {int ms = 1400, int pause = 1500}) async {
    if (position.extentAfter < 1) return;
    final target = (position.pixels + position.viewportDimension * screens).clamp(0.0, position.maxScrollExtent);
    await position.animateTo(target, duration: Duration(milliseconds: ms), curve: Curves.easeInOutCubic);
    await hold(tester, pause);
  }

  event('blocks $label ${article.blocks.length}');
  await step(0.5);
  await step(0.5);
  for (final stop in _pickStops(article.blocks, tourStops)) {
    final distance = (list.getOffsetToReveal(stop.index, 0.15) - position.pixels).abs();
    final ms = (900 + distance / position.viewportDimension * 160).clamp(1100, 3400).round();
    list.animateToItem(
      index: stop.index,
      scrollController: scroll,
      alignment: 0.15,
      duration: (_) => Duration(milliseconds: ms),
      curve: (_) => Curves.easeInOutCubic,
    );
    await hold(tester, ms + 400);
    event('stop $label ${stop.kind} block ${stop.index}/${article.blocks.length}');
    final view = find.byWidgetPredicate((w) => w is BlockView && identical(w.block, article.blocks[stop.index]));
    await hold(tester, 1200);
    switch (stop.kind) {
      case 'table' || 'code' || 'math':
        await _slideSideways(tester, view);
      case 'details':
        final toggle = find.descendant(of: view, matching: find.byType(InkWell));
        if (toggle.evaluate().isNotEmpty) {
          await tester.tap(toggle.first, warnIfMissed: false);
          await hold(tester, 1800);
        }
      case 'footnote':
        final context = view.evaluate().firstOrNull;
        if (context != null) {
          ArticleScope.of(context).onFootnote(stop.footnote!);
          await hold(tester, 2600);
          final back = find.text('Back to text');
          if (back.evaluate().isNotEmpty) {
            await tester.tap(back.first, warnIfMissed: false);
            await hold(tester, 1200);
          }
        }
      default:
        await hold(tester, 800);
    }
    await step(0.35, ms: 1100, pause: 1000);
  }
}

/// Slides the block's horizontal scroller (a wide table or long code lines)
/// to the side and back, when it has somewhere to go.
Future<void> _slideSideways(WidgetTester tester, Finder view) async {
  final scrollers = find.descendant(of: view, matching: find.byType(Scrollable));
  for (final element in scrollers.evaluate()) {
    final state = (element as StatefulElement).state as ScrollableState;
    final p = state.position;
    if (p.axis != Axis.horizontal || p.maxScrollExtent < 24) continue;
    await p.animateTo(min(p.maxScrollExtent, p.viewportDimension * 0.7), duration: const Duration(milliseconds: 1300), curve: Curves.easeInOutCubic);
    await hold(tester, 900);
    await p.animateTo(0, duration: const Duration(milliseconds: 900), curve: Curves.easeInOutCubic);
    await hold(tester, 500);
    return;
  }
  await hold(tester, 1000);
}
