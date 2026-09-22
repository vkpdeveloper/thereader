import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;

import '../../core/theme/tokens.dart';
import '../../data/models/library.dart';
import '../../data/models/settings.dart';
import '../../data/storage/book_store.dart';
import '../engine/reader_engine.dart';

/// Native Readium engine via the `flutter_readium` plugin (swift-toolkit 3.9
/// on iOS, kotlin-toolkit 3.2 on Android). Paginated and scrolled flows,
/// publisher CSS, full EPUB 2/3 fidelity. Not available on web in this build
/// (the JS bundle is not shipped), where the built-in Dart engine is used.
class ReadiumReaderEngine implements ReaderEngine {
  const ReadiumReaderEngine();

  static const String engineId = 'readium';

  @override
  String get id => engineId;

  @override
  EngineAvailability get availability => kIsWeb
      ? const EngineAvailability.unavailable(
          'Readium (native)', 'Not bundled for the browser preview; the built-in engine is used.')
      : const EngineAvailability.available(
          'Readium (native)',
          note: 'Readium swift-toolkit 3.9 / kotlin-toolkit 3.2 through flutter_readium 0.3.3. '
              'Paginated or scrolled, publisher styles, full EPUB fidelity.',
        );

  @override
  Future<ReaderController> open({
    required BookFile file,
    required ReaderPreferences prefs,
    ReadingLocator? initialLocator,
  }) async {
    final path = file.path;
    if (path == null) throw UnsupportedError('Readium needs an on-disk file.');
    final readium = rd.FlutterReadium();
    readium.setDefaultPreferences(ReadiumReaderController.toEpubPreferences(prefs));
    final publication = await readium.openPublication(path);
    return ReadiumReaderController(
      readium: readium,
      publication: publication,
      prefs: prefs,
      initial: initialLocator,
    );
  }

  @override
  Widget buildView(BuildContext context, ReaderController controller) =>
      _ReadiumView(controller: controller as ReadiumReaderController);
}

class ReadiumReaderController implements ReaderController {
  ReadiumReaderController({
    required this.readium,
    required this.publication,
    required ReaderPreferences prefs,
    ReadingLocator? initial,
  }) {
    _locator = ValueNotifier(initial);
    initialLocator = _toReadium(initial);
    _sub = readium.onTextLocatorChanged.listen(_onLocator);
    _errSub = readium.onErrorEvent.listen((e) => debugPrint('[readium] $e'));
    _info = PublicationInfo(
      title: publication.metadata.title,
      author: publication.metadata.authors.map((a) => a.name).join(', '),
      spineCount: publication.readingOrder.length,
      toc: _flattenToc(publication.tableOfContents, 0),
      language: publication.metadata.languages.firstOrNull,
    );
    // The plugin reads default preferences when the native view is created;
    // push them again once the reader reports ready so late changes apply.
    _statusSub = readium.onReaderStatusChanged.listen((s) {
      if (!_ready && s == rd.ReadiumReaderStatus.ready) {
        _ready = true;
        unawaited(readium.setEPUBPreferences(toEpubPreferences(_prefs)));
      }
    });
    _prefs = prefs;
  }

  final rd.FlutterReadium readium;
  final rd.Publication publication;
  late final rd.Locator? initialLocator;
  late final PublicationInfo _info;
  late final ValueNotifier<ReadingLocator?> _locator;
  late ReaderPreferences _prefs;
  StreamSubscription<rd.Locator>? _sub;
  StreamSubscription<rd.ReadiumError>? _errSub;
  StreamSubscription<rd.ReadiumReaderStatus>? _statusSub;
  bool _ready = false;
  final ValueNotifier<bool> showControls = ValueNotifier(false);

  @override
  PublicationInfo get info => _info;

  @override
  ValueListenable<ReadingLocator?> get locator => _locator;

  @override
  ValueListenable<bool> get controlsToggle => showControls;

  static List<TocEntry> _flattenToc(List<rd.Link> links, int depth) => [
        for (final l in links) ...[
          TocEntry(title: (l.title ?? l.href).trim(), href: l.href, depth: depth),
          ..._flattenToc(l.children, depth + 1),
        ],
      ];

  void _onLocator(rd.Locator l) {
    final loc = l.locations;
    _locator.value = ReadingLocator(
      href: l.href,
      progression: loc?.progression ?? 0,
      totalProgression: loc?.totalProgression,
      title: l.title ?? _tocTitle(l.href),
      engine: ReadiumReaderEngine.engineId,
      raw: l.toJson(),
    );
  }

  String? _tocTitle(String href) {
    final clean = href.split('#').first;
    for (final t in _info.toc) {
      if (t.href.split('#').first == clean) return t.title;
    }
    return null;
  }

  rd.Locator? _toReadium(ReadingLocator? l) {
    if (l == null) return null;
    final raw = l.raw;
    if (l.engine == ReadiumReaderEngine.engineId && raw != null) {
      final parsed = rd.Locator.fromJson(Map<String, dynamic>.of(raw));
      if (parsed != null) return parsed;
    }
    // Locator from the built-in engine: same href convention (path inside the
    // container), so Readium can resolve it plus a progression fraction.
    final link = publication.linkWithHref(l.href) ??
        publication.linkWithHref('/${l.href}') ??
        publication.readingOrder.where((x) => x.href.endsWith(l.href)).firstOrNull;
    if (link == null) return null;
    return rd.Locator(
      href: link.href,
      type: link.type ?? 'application/xhtml+xml',
      locations: rd.Locations(progression: l.progression),
    );
  }

  @override
  Future<void> goTo(ReadingLocator locator) async {
    final l = _toReadium(locator);
    if (l != null) await readium.goToLocator(l);
  }

  @override
  Future<void> goToHref(String href) async {
    final link = publication.linkWithHref(href) ?? publication.linkWithHref(href.split('#').first);
    await readium.goToLocator(rd.Locator(href: href, type: link?.type ?? 'application/xhtml+xml'));
  }

  @override
  Future<bool> next() async {
    await readium.goForward();
    return true;
  }

  @override
  Future<bool> previous() async {
    await readium.goBackward();
    return true;
  }

  @override
  void applyPreferences(ReaderPreferences prefs) {
    _prefs = prefs;
    unawaited(readium.setEPUBPreferences(toEpubPreferences(prefs)));
  }

  /// Maps app preferences onto Readium's. Colors are pinned to the app palette
  /// so the native surface never flashes white.
  static rd.EPUBPreferences toEpubPreferences(ReaderPreferences p) => rd.EPUBPreferences(
        backgroundColor: Palette.bg,
        textColor: Palette.fg,
        // Bundled app fonts are not registered inside the native WebView; fall
        // back through good system faces so the choice still reads as intended.
        fontFamily: p.font == ReaderFont.serif
            ? 'Literata, Charter, Georgia, serif'
            : 'Inter, -apple-system, Roboto, Helvetica Neue, sans-serif',
        fontSize: p.fontSize / 16.0,
        lineHeight: p.lineHeight,
        pageMargins: 0.8 + p.marginScale * 0.6,
        scroll: p.flow == ReaderFlow.scrolled,
        textAlign: p.justify ? TextAlign.justify : TextAlign.left,
        publisherStyles: false,
      );

  @override
  void dispose() {
    _sub?.cancel();
    _errSub?.cancel();
    _statusSub?.cancel();
    showControls.dispose();
    _locator.dispose();
    // Let the native view tear down before closing the publication.
    Future<void>.delayed(const Duration(milliseconds: 300), readium.closePublication);
  }
}

class _ReadiumView extends StatelessWidget {
  const _ReadiumView({required this.controller});
  final ReadiumReaderController controller;

  @override
  Widget build(BuildContext context) {
    // Keep the native page clear of the status bar and home indicator; the
    // margins inside the page come from EPUBPreferences.pageMargins.
    final insets = MediaQuery.paddingOf(context);
    return ColoredBox(
      color: Palette.bg,
      child: Padding(
        // The status bar is hidden while reading, so guarantee a top breath
        // even when the safe-area inset collapses to zero.
        padding: EdgeInsets.only(
          top: insets.top < Space.lg ? Space.lg : insets.top,
          bottom: insets.bottom,
        ),
        child: rd.ReadiumReaderWidget(
          publication: controller.publication,
          initialLocator: controller.initialLocator,
          shouldShowControls: controller.showControls,
          loadingWidget: const ColoredBox(color: Palette.bg),
          allowedDefaultActions: const {rd.DefaultSelectionAction.copy},
        ),
      ),
    );
  }
}
