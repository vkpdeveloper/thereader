import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;

import '../../core/theme/app_colors.dart';
import '../../core/theme/theme_presets.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
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

  static Future<void> _closing = Future.value();

  static const String engineId = 'readium';

  @override
  String get id => engineId;

  @override
  EngineAvailability get availability => kIsWeb
      ? const EngineAvailability.unavailable(
          'Readium (native)',
          'Not bundled for the browser preview; the built-in engine is used.',
        )
      : const EngineAvailability.available(
          'Readium (native)',
          note:
              'Readium swift-toolkit 3.9 / kotlin-toolkit 3.2 through flutter_readium 0.3.3. '
              'Paginated or scrolled, publisher styles, full EPUB fidelity.',
        );

  @override
  Future<ReaderController> open({
    required BookFile file,
    required ReaderPreferences prefs,
    ReadingLocator? initialLocator,
  }) async {
    await _closing;
    final colors = ThemePreset.byId(prefs.themeId).colors;
    final path = file.path;
    if (path == null) {
      throw UnsupportedError(
        'Readium needs a file or a leased publication URL.',
      );
    }
    final readium = rd.FlutterReadium();
    try {
      readium.setDefaultPreferences(
        ReadiumReaderController.toEpubPreferences(prefs, colors),
      );
      final publication = await readium.openPublication(path);
      return ReadiumReaderController(
        readium: readium,
        publication: publication,
        file: file,
        prefs: prefs,
        initial: initialLocator,
      );
    } catch (_) {
      // A failed open can still leave native resources reading from the proxy.
      _closing = closeAndRelease(readium, file);
      await _closing;
      rethrow;
    }
  }

  static Future<void> closeAndRelease(
    rd.FlutterReadium readium,
    BookFile file,
  ) async {
    try {
      await readium.closePublication();
    } catch (error) {
      debugPrint('[readium] close failed: $error');
    } finally {
      try {
        await file.close();
      } catch (error) {
        debugPrint('[readium] lease release failed: $error');
      }
    }
  }

  @override
  Widget buildView(BuildContext context, ReaderController controller) =>
      _ReadiumView(controller: controller as ReadiumReaderController);
}

class ReadiumReaderController implements ReaderController, ReaderSearch {
  ReadiumReaderController({
    required this.readium,
    required this.publication,
    required this.file,
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
        unawaited(readium.setEPUBPreferences(toEpubPreferences(_prefs, _colors)));
      }
    });
    _prefs = prefs;
    _colors = ThemePreset.byId(prefs.themeId).colors;
  }

  final rd.FlutterReadium readium;
  final rd.Publication publication;
  // A provisional URL remains live until native publication teardown completes.
  final BookFile file;
  bool _disposed = false;
  late final rd.Locator? initialLocator;
  late final PublicationInfo _info;
  late final ValueNotifier<ReadingLocator?> _locator;
  late ReaderPreferences _prefs;
  late AppColors _colors;

  /// Colours last pushed to the native view; tests read this.
  AppColors get colors => _colors;
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
    final link =
        publication.linkWithHref(l.href) ??
        publication.linkWithHref('/${l.href}') ??
        publication.readingOrder
            .where((x) => x.href.endsWith(l.href))
            .firstOrNull;
    if (link == null) return null;
    return rd.Locator(
      href: link.href,
      type: link.type ?? 'application/xhtml+xml',
      locations: rd.Locations(progression: l.progression),
    );
  }

  @override
  Future<List<ReaderSearchMatch>> search(String query) async {
    final results = await readium.searchInPublication(query.trim());
    return results.map((r) {
      final l = r.locator;
      return ReaderSearchMatch(
        excerpt: [
          l.text?.before,
          l.text?.highlight,
          l.text?.after,
        ].whereType<String>().join().trim(),
        locator: ReadingLocator(
          href: l.href,
          progression: l.locations?.progression ?? 0,
          totalProgression: l.locations?.totalProgression,
          title: r.chapterTitle,
          engine: ReadiumReaderEngine.engineId,
          raw: l.toJson(),
        ),
      );
    }).toList();
  }

  @override
  Future<void> goTo(ReadingLocator locator) async {
    final l = _toReadium(locator);
    if (l != null) await readium.goToLocator(l);
  }

  @override
  Future<void> goToHref(String href) async {
    final link =
        publication.linkWithHref(href) ??
        publication.linkWithHref(href.split('#').first);
    await readium.goToLocator(
      rd.Locator(href: href, type: link?.type ?? 'application/xhtml+xml'),
    );
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
    _colors = ThemePreset.byId(prefs.themeId).colors;
    unawaited(readium.setEPUBPreferences(toEpubPreferences(prefs, _colors)));
  }

  /// Maps app preferences onto Readium's. Colours are pinned to the active
  /// preset's paper/ink so the native surface never flashes white and follows
  /// a theme change immediately.
  static rd.EPUBPreferences toEpubPreferences(
    ReaderPreferences p,
    AppColors colors,
  ) => rd.EPUBPreferences(
    backgroundColor: colors.paper,
    textColor: colors.ink,
    // A single family name: Readium appends the declared fallback (serif or
    // sans-serif) itself; a comma-separated string would be treated as one
    // nonexistent family. Bundled names are declared natively at creation via
    // `fontFamilies`, system choices use the platform generic.
    fontFamily: ReaderFonts.resolve(p).readiumFamily,
    fontSize: p.fontSize / 16.0,
    lineHeight: p.lineHeight,
    pageMargins: 0.8 + p.marginScale * 0.6,
    scroll: p.flow == ReaderFlow.scrolled,
    textAlign: p.justify ? TextAlign.justify : TextAlign.left,
    publisherStyles: false,
  );

  /// Every bundled family, declared once per navigator so switching fonts
  /// never recreates the view. Faces are served lazily from app assets.
  static final List<Map<String, Object>> readiumFontFamilies = [
    for (final f in ReaderFonts.bundled) f.toNativeJson(),
  ];

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _sub?.cancel();
    _errSub?.cancel();
    _statusSub?.cancel();
    showControls.dispose();
    _locator.dispose();
    // Complete close before the next open; no delayed close may target a new book.
    ReadiumReaderEngine._closing = ReadiumReaderEngine.closeAndRelease(
      readium,
      file,
    );
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
    final paper = context.colors.paper;
    return ColoredBox(
      color: paper,
      child: Padding(
        // The status bar is hidden while reading, so guarantee a top breath
        // even when the safe-area inset collapses to zero.
        padding: EdgeInsets.only(
          top: insets.top < Space.lg ? Space.lg : insets.top,
          bottom: insets.bottom,
        ),
        child: rd.ReadiumReaderWidget(
          publication: controller.publication,
          // The disk downloader already fills the rest in the background.
          // Avoid competing speculative chapter loads during an early open.
          preloadPreviousPositionCount: controller.file.isProvisional ? 0 : 2,
          preloadNextPositionCount: controller.file.isProvisional ? 0 : 6,
          initialLocator: controller.initialLocator,
          shouldShowControls: controller.showControls,
          loadingWidget: ColoredBox(color: paper),
          allowedDefaultActions: const {rd.DefaultSelectionAction.copy},
          fontFamilies: ReadiumReaderController.readiumFontFamilies,
        ),
      ),
    );
  }
}
