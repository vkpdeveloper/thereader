import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;

import '../../core/theme/app_colors.dart';
import '../../core/theme/highlight_colors.dart';
import '../../core/theme/theme_presets.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
import '../../data/models/highlight.dart';
import '../../data/models/library.dart';
import '../../data/models/settings.dart';
import '../../data/storage/book_store.dart';
import '../engine/reader_engine.dart';
import '../enhance/enhanced_epub.dart';

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
      // Stored books open as a derived copy with the content enhancer linked
      // into every document (maths, code, dark-ink images). Same hrefs, so
      // locators and highlights carry over. A streaming lease has no complete
      // file to derive from and opens as is.
      final source = file.isProvisional
          ? path
          : await EnhancedEpubCache.resolve(path);
      final publication = await readium.openPublication(source);
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

class ReadiumReaderController
    implements
        ReaderController,
        ReaderSearch,
        ReaderAnnotations,
        ReaderChapterStart,
        ReaderLinks {
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
    // The native view receives the opening preferences at creation. Replaying
    // them at first paint needlessly repeats layout on image-heavy chapters.
    // Only preferences changed during loading need to be sent again.
    _statusSub = readium.onReaderStatusChanged.listen((s) {
      if (!_ready && s == rd.ReadiumReaderStatus.ready) {
        _ready = true;
        pageVisible.value = true;
        if (_pendingPreferences) {
          _pendingPreferences = false;
          unawaited(
            readium.setEPUBPreferences(toEpubPreferences(_prefs, _colors)),
          );
        }
        _pushHighlights();
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
  bool _pendingPreferences = false;

  /// Set when the native page is on screen (Readium's `ready`). The plugin's
  /// loading cover otherwise waits for the first page event, which Android
  /// delays for a ToC lookup over the whole chapter. Android now emits ready
  /// only for the current page, not an off-screen chapter finishing first.
  final pageVisible = ValueNotifier(false);
  final ValueNotifier<bool> showControls = ValueNotifier(false);
  final _highlightRequests = StreamController<HighlightSelection>.broadcast();
  final _highlightTaps = StreamController<String>.broadcast();
  final _externalLinks = StreamController<Uri>.broadcast();
  List<Highlight> _highlights = const [];

  static const _highlightGroup = 'highlights';

  /// Android's custom selection menu replaces the system one, Copy included,
  /// so Copy is re-added there as an app action. iOS keeps the system Copy.
  static final List<rd.SelectionAction> selectionActions = [
    const rd.SelectionAction(id: 'highlight', title: 'Highlight'),
    if (!kIsWeb && Platform.isAndroid)
      const rd.SelectionAction(id: 'copy', title: 'Copy'),
  ];

  @override
  PublicationInfo get info => _info;

  @override
  ValueListenable<ReadingLocator?> get locator => _locator;

  @override
  ValueListenable<bool> get controlsToggle => showControls;

  @override
  Stream<HighlightSelection> get highlightRequests => _highlightRequests.stream;

  @override
  Stream<String> get highlightTaps => _highlightTaps.stream;

  @override
  Stream<Uri> get externalLinks => _externalLinks.stream;

  void onExternalLink(String url) {
    final uri = Uri.tryParse(url);
    if (uri != null && !_disposed) _externalLinks.add(uri);
  }

  @override
  void setHighlights(List<Highlight> highlights) {
    _highlights = highlights;
    _pushHighlights();
  }

  /// Decorations can only be applied to a live navigator; [setHighlights]
  /// before ready is replayed once the reader reports ready.
  void _pushHighlights() {
    if (!_ready || _disposed) return;
    final decorations = <rd.ReaderDecoration>[];
    for (final h in _highlights) {
      final locator = rd.Locator.fromJson(Map<String, dynamic>.of(h.locator));
      if (locator == null) continue;
      decorations.add(
        rd.ReaderDecoration(
          id: h.id,
          locator: locator,
          style: rd.ReaderDecorationStyle(
            style: rd.DecorationStyle.highlight,
            tint: HighlightColors.tint(h.colorKey, _colors),
          ),
        ),
      );
    }
    unawaited(
      readium
          .applyDecorations(_highlightGroup, decorations)
          .catchError((Object e) => debugPrint('[readium] decorations: $e')),
    );
  }

  void onSelectionAction(rd.SelectionActionEvent e) {
    final text = (e.selectedText ?? e.locator.text?.highlight ?? '').trim();
    if (text.isEmpty) return;
    switch (e.actionId) {
      case 'highlight':
        _highlightRequests.add(
          HighlightSelection(locator: e.locator.toJson(), text: text),
        );
      case 'copy':
        unawaited(Clipboard.setData(ClipboardData(text: text)));
    }
  }

  void onDecorationInteraction(rd.DecorationInteractionEvent e) {
    if (e.group == _highlightGroup &&
        e.type == rd.DecorationInteractionType.tap) {
      _highlightTaps.add(e.decorationId);
    }
  }

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

  rd.Locator? _toReadium(ReadingLocator? l) => resolveLocator(publication, l);

  /// Maps a saved locator onto [publication], or null to open at the start.
  /// A locator whose href names no reading-order item (a stale or corrupt
  /// save, or one from another edition) is dropped rather than handed to
  /// Readium, which cannot place it.
  @visibleForTesting
  static rd.Locator? resolveLocator(
    rd.Publication publication,
    ReadingLocator? l,
  ) {
    if (l == null) return null;
    final raw = l.raw;
    if (l.engine == ReadiumReaderEngine.engineId && raw != null) {
      final parsed = rd.Locator.fromJson(Map<String, dynamic>.of(raw));
      if (parsed != null && _spineLink(publication, parsed.href) != null) {
        return parsed;
      }
    }
    // Locator from the built-in engine: same href convention (path inside the
    // container), so Readium can resolve it plus a progression fraction.
    final link = _spineLink(publication, l.href);
    if (link == null) return null;
    final progression = l.progression.isFinite
        ? l.progression.clamp(0.0, 1.0)
        : 0.0;
    return rd.Locator(
      href: link.href,
      type: link.type ?? 'application/xhtml+xml',
      locations: rd.Locations(progression: progression),
    );
  }

  static rd.Link? _spineLink(rd.Publication publication, String href) {
    String path(String h) {
      final end = h.indexOf(RegExp('[#?]'));
      final p = end == -1 ? h : h.substring(0, end);
      return p.startsWith('/') ? p.substring(1) : p;
    }

    final target = path(href);
    if (target.isEmpty) return null;
    final spine = publication.readingOrder;
    return spine.where((x) => path(x.href) == target).firstOrNull ??
        spine.where((x) => path(x.href).endsWith('/$target')).firstOrNull;
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

  /// Progression is within the current resource; the vendored plugin
  /// animates it (see THEREADER.md).
  @override
  Future<void> toChapterStart() => readium.goToProgression(0);

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
    final themeChanged = prefs.themeId != _prefs.themeId;
    _prefs = prefs;
    _colors = ThemePreset.byId(prefs.themeId).colors;
    if (_ready) {
      unawaited(readium.setEPUBPreferences(toEpubPreferences(prefs, _colors)));
    } else {
      _pendingPreferences = true;
    }
    // Tints are resolved per theme, so a theme change redraws them.
    if (themeChanged) _pushHighlights();
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
    pageVisible.dispose();
    _highlightRequests.close();
    _highlightTaps.close();
    _externalLinks.close();
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
          // Lifts on `ready` even if the first page event is late: the cover
          // is opaque and swallows touches.
          loadingWidget: ValueListenableBuilder(
            valueListenable: controller.pageVisible,
            builder: (_, visible, _) =>
                visible ? const SizedBox.shrink() : ColoredBox(color: paper),
          ),
          allowedDefaultActions: const {rd.DefaultSelectionAction.copy},
          selectionActions: ReadiumReaderController.selectionActions,
          onSelectionAction: controller.onSelectionAction,
          onDecorationInteraction: controller.onDecorationInteraction,
          onExternalLinkActivated: controller.onExternalLink,
          fontFamilies: ReadiumReaderController.readiumFontFamilies,
        ),
      ),
    );
  }
}
