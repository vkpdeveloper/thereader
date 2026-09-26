import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app_scope.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/highlight.dart';
import '../../data/models/library.dart';
import '../../data/storage/book_store.dart';
import '../../reader/engine/reader_engine.dart';
import '../shared/states.dart';
import 'highlight_sheets.dart';
import 'reader_settings_sheet.dart';
import 'reader_search_sheet.dart';

/// The reading surface. Chrome is hidden by default and revealed with a tap;
/// position is saved continuously and on exit.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({super.key, required this.entry}) : _session = null;
  const ReaderScreen._(this.entry, this._session);

  final LibraryEntry entry;
  final _ReaderSession? _session;
  static bool _routeActive = false;
  static Completer<void>? _routeDone;

  /// File-manager opens replace any current book and start reading at once.
  static Future<void> openExternal(
    BuildContext context,
    LibraryEntry entry,
  ) async {
    final navigator = Navigator.of(context);
    navigator.popUntil((route) => route.isFirst);
    await _routeDone?.future;
    if (context.mounted) unawaited(open(context, entry));
  }

  static Future<void> open(BuildContext context, LibraryEntry entry) async {
    if (_routeActive) return;
    _routeActive = true;
    final done = _routeDone = Completer<void>();
    final session = _ReaderSession();
    try {
      final route = PageRouteBuilder<void>(
        transitionDuration: Motion.of(context, Motion.slow),
        reverseTransitionDuration: Motion.of(context, Motion.base),
        pageBuilder: (_, _, _) => ReaderScreen._(entry, session),
        transitionsBuilder: (_, anim, _, child) => FadeTransition(
          opacity: CurvedAnimation(parent: anim, curve: Motion.curve),
          child: child,
        ),
      );
      Navigator.of(context).push(route);
      // pop() completes before the exit animation disposes the old native view.
      await route.completed;
      // Back can also happen while the publication is still opening. Its late
      // unmounted-controller cleanup must finish before another owner starts.
      await session.opening;
    } finally {
      _routeActive = false;
      done.complete();
      if (identical(_routeDone, done)) _routeDone = null;
    }
  }

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderSession {
  Future<void> opening = Future<void>.value();
}

class _ReaderScreenState extends State<ReaderScreen>
    with WidgetsBindingObserver {
  late AppServices _services;
  ReaderController? _controller;
  ReaderEngine? _engine;
  String? _error;
  String? _fallbackNote;
  bool _chromeVisible = false;
  bool _provisional = false;
  bool _listeningLibrary = false;
  Timer? _saveDebounce;
  final List<StreamSubscription<Object>> _annotationSubs = [];
  StreamSubscription<Uri>? _linkSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    final opened = Completer<void>();
    widget._session?.opening = opened.future;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        if (mounted) await _open();
      } finally {
        opened.complete();
      }
    });
  }

  /// Captured on every dependency change so dispose can restore the system
  /// bars for the active preset without touching an unmounted context.
  AppColors _colors = AppColors.defaults;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _colors = AppColors.of(context);
    _services = AppScope.of(context);
    if (!_listeningLibrary) {
      _services.library.addListener(_onDownloadChange);
      _listeningLibrary = true;
    }
  }

  Future<void> _open() async {
    final services = _services;
    if (!services.library.canRead(widget.entry.id)) {
      setState(() => _error = 'This book has not been downloaded.');
      return;
    }
    try {
      final candidates = services.readerService.candidates(
        services.settings.settings.preferredEngine,
      );
      ReaderEngine? engine;
      ReaderController? controller;
      Object? firstError;
      for (final candidate in candidates) {
        final file = await services.library.openForReading(widget.entry.id);
        if (file.isProvisional && candidate.id != 'readium') {
          await file.close();
          firstError ??= StateError(
            'Early reading needs the native reader. Wait for the download to finish.',
          );
          continue;
        }
        try {
          _provisional = file.isProvisional;
          controller = await candidate.open(
            file: file,
            prefs: services.settings.reader,
            initialLocator: widget.entry.progress?.locator,
          );
          engine = candidate;
          break;
        } catch (e) {
          await file.close();
          firstError ??= e;
          debugPrint('[reader] ${candidate.id} failed to open: $e');
        }
      }
      if (engine == null || controller == null) {
        throw firstError ?? StateError('No engine could open the book.');
      }
      if (engine.id != candidates.first.id) {
        _fallbackNote =
            '${candidates.first.availability.name} could not open this book; using ${engine.availability.name}.';
      }
      if (!mounted) {
        controller.dispose();
        return;
      }
      if (_provisional && !_streamStillValid) {
        controller.dispose();
        throw StateError(
          'The download stopped. Return to your library to retry.',
        );
      }
      controller.locator.addListener(_onLocator);
      controller.controlsToggle?.addListener(_onEngineControls);
      services.settings.addListener(_onPrefs);
      unawaited(
        services.library.markOpened(
          widget.entry.id,
          expectedSha256: widget.entry.book.sha256,
        ),
      );
      if (!mounted) {
        controller.dispose();
        return;
      }
      final e = engine;
      final c = controller;
      setState(() {
        _engine = e;
        _controller = c;
      });
      final note = _fallbackNote;
      if (note != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(note), duration: const Duration(seconds: 5)),
        );
      }
      _attachHighlights(c);
      if (c is ReaderLinks) {
        _linkSub = (c as ReaderLinks).externalLinks.listen(_openExternal);
      }
      services.sync?.beginReading(widget.entry);
      // Record the opening position so "Continue reading" appears immediately.
      _onLocator();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  /// Highlights come from the local cache only; sync refreshes that cache on
  /// its own schedule, so opening a book never costs a request.
  void _attachHighlights(ReaderController c) {
    final repo = _services.highlights;
    if (c is! ReaderAnnotations || repo == null) return;
    final a = c as ReaderAnnotations;
    repo.addListener(_pushHighlights);
    _annotationSubs
      ..add(a.highlightRequests.listen(_createHighlight))
      ..add(
        a.highlightTaps.listen((id) {
          if (mounted) showHighlightActions(context, repo, id);
        }),
      );
    _pushHighlights();
  }

  void _pushHighlights() {
    final c = _controller;
    final repo = _services.highlights;
    if (c is! ReaderAnnotations || repo == null) return;
    (c as ReaderAnnotations).setHighlights(
      repo.forEdition(widget.entry.origin, widget.entry.book.sha256),
    );
  }

  Future<void> _createHighlight(HighlightSelection selection) async {
    final repo = _services.highlights;
    if (repo == null) return;
    // Selection locators may lack the position and chapter; borrow them
    // from the current page so the list can sort and label the passage.
    final here = _controller?.locator.value;
    final locator = Map<String, dynamic>.of(selection.locator);
    final locations = Map<String, dynamic>.of(
      (locator['locations'] as Map?)?.cast<String, dynamic>() ?? const {},
    );
    if (locations['totalProgression'] == null &&
        here?.totalProgression != null) {
      locations['totalProgression'] = here!.totalProgression;
    }
    locator['locations'] = locations;
    if (locator['title'] == null && here?.title != null) {
      locator['title'] = here!.title;
    }
    await repo.create(
      bookId: widget.entry.book.id,
      sha256: widget.entry.book.sha256,
      origin: widget.entry.origin,
      locator: locator,
      text: selection.text,
      color: HighlightColor.parse(
        _services.settings.reader.highlightColor,
      ).name,
    );
  }

  void _openHighlights() {
    final repo = _services.highlights;
    final c = _controller;
    if (repo == null || c == null) return;
    showHighlightsList(
      context,
      repo: repo,
      origin: widget.entry.origin,
      sha256: widget.entry.book.sha256,
      onOpen: (h) => c.goTo(
        ReadingLocator(
          href: h.href,
          progression:
              ((h.locator['locations'] as Map?)?['progression'] as num?)
                  ?.toDouble() ??
              0,
          title: h.chapter,
          engine: 'readium',
          raw: h.locator,
        ),
      ),
    );
  }

  /// Web links open in an in-app browser; mail and phone links go to their
  /// apps. Anything else is ignored.
  Future<void> _openExternal(Uri uri) async {
    final scheme = uri.scheme.toLowerCase();
    final web = scheme == 'http' || scheme == 'https';
    if (!web && scheme != 'mailto' && scheme != 'tel') return;
    var opened = false;
    try {
      opened = await launchUrl(
        uri,
        mode: web
            ? LaunchMode.inAppBrowserView
            : LaunchMode.externalApplication,
      );
    } catch (_) {}
    if (!opened && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text("Couldn't open link.")));
    }
  }

  void _detachHighlights() {
    for (final s in _annotationSubs) {
      s.cancel();
    }
    _annotationSubs.clear();
    _services.highlights?.removeListener(_pushHighlights);
  }

  void _onPrefs() => _controller?.applyPreferences(_services.settings.reader);

  bool get _streamStillValid {
    final entry = _services.library.entry(widget.entry.id);
    return entry?.book.sha256 == widget.entry.book.sha256 &&
        _services.library.canRead(widget.entry.id);
  }

  void _onDownloadChange() {
    if (!_provisional || _controller == null || !mounted || _streamStillValid) {
      return;
    }
    _provisional = false;
    _services.sync?.endReading();
    _saveNow();
    _controller?.locator.removeListener(_onLocator);
    _controller?.controlsToggle?.removeListener(_onEngineControls);
    _detachHighlights();
    _linkSub?.cancel();
    _linkSub = null;
    _controller?.dispose();
    setState(() {
      _controller = null;
      _error = 'The download stopped. Return to your library to retry.';
    });
  }

  void _onEngineControls() {
    final v = _controller?.controlsToggle?.value;
    if (v != null && v != _chromeVisible && mounted) {
      setState(() => _chromeVisible = v);
    }
  }

  void _onLocator() {
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 600), _saveNow);
  }

  void _saveNow() {
    final loc = _controller?.locator.value;
    if (loc == null || !mounted) return;
    _services.library.saveProgress(
      widget.entry.id,
      loc,
      expectedSha256: widget.entry.book.sha256,
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _saveDebounce?.cancel();
      _saveNow();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    final sync = _services.sync;
    Future.microtask(() => sync?.endReading());
    _saveDebounce?.cancel();
    final loc = _controller?.locator.value;
    if (loc != null) {
      // Dispose runs while the tree is locked; notify listeners afterwards.
      final services = _services;
      final id = widget.entry.id;
      final expectedSha256 = widget.entry.book.sha256;
      Future.microtask(
        () => services.library.saveProgress(
          id,
          loc,
          expectedSha256: expectedSha256,
        ),
      );
    }
    if (_listeningLibrary) _services.library.removeListener(_onDownloadChange);
    _services.settings.removeListener(_onPrefs);
    _controller?.locator.removeListener(_onLocator);
    _controller?.controlsToggle?.removeListener(_onEngineControls);
    _detachHighlights();
    _linkSub?.cancel();
    _linkSub = null;
    _controller?.dispose();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(AppTheme.overlayFor(_colors));
    super.dispose();
  }

  void _toggleChrome() {
    setState(() => _chromeVisible = !_chromeVisible);
    final t = _controller?.controlsToggle;
    if (t is ValueNotifier<bool>) t.value = _chromeVisible;
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    final colors = context.colors;
    Widget body;
    if (_error != null) {
      body = SafeArea(
        child: StateMessage(
          title: "Couldn't open this book.",
          body: _error,
          error: true,
          actionLabel: 'Back',
          onAction: () => Navigator.of(context).maybePop(),
        ),
      );
    } else if (controller == null) {
      body = const SafeArea(child: LoadingLine(label: 'Opening'));
    } else {
      body = Stack(
        children: [
          ReaderTapRouting(
            engineHandlesTaps: controller.controlsToggle != null,
            onTap: _toggleChrome,
            child: _engine!.buildView(context, controller),
          ),
          _EdgeProgress(visible: !_chromeVisible, controller: controller),
          _TopChrome(
            visible: _chromeVisible,
            title: widget.entry.book.title,
            controller: controller,
            engineName: _engine!.availability.name,
            onSettings: () => _openSettings(controller),
            onHighlights:
                controller is ReaderAnnotations && _services.highlights != null
                ? _openHighlights
                : null,
          ),
          _BottomChrome(visible: _chromeVisible, controller: controller),
          if (controller is ReaderChapterStart)
            _ToChapterStart(
              chromeVisible: _chromeVisible,
              controller: controller,
            ),
          if (_provisional)
            Positioned(
              left: Space.gutter,
              // Floats just above the bottom chrome (~65dp) and its hairline.
              bottom: MediaQuery.paddingOf(context).bottom + 65 + Space.sm,
              child: IgnorePointer(
                child: AnimatedBuilder(
                  animation: _services.library,
                  builder: (context, _) {
                    final download = _services.library
                        .entry(widget.entry.id)
                        ?.download;
                    if (!_chromeVisible || download?.isActive != true) {
                      return const SizedBox.shrink();
                    }
                    return Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: colors.bg,
                        borderRadius: const BorderRadius.all(Radii.sm),
                      ),
                      child: Text(
                        'Downloading · ${((download?.fraction ?? 0) * 100).floor()}%',
                        style: Theme.of(
                          context,
                        ).textTheme.labelSmall?.copyWith(color: colors.muted),
                      ),
                    );
                  },
                ),
              ),
            ),
        ],
      );
    }
    return Scaffold(
      backgroundColor: colors.paper,
      body: AnnotatedRegion<SystemUiOverlayStyle>(
        value: AppTheme.overlayFor(colors),
        child: body,
      ),
    );
  }

  Future<void> _openSettings(ReaderController controller) async {
    final services = _services;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      barrierColor: Colors.black54,
      builder: (_) => ReaderSettingsSheet(
        settings: services.settings,
        engineName: _engine!.availability.name,
        engineNote: _engine!.availability.note,
      ),
    );
  }
}

/// Routes taps on the book view to [onTap] only when the engine can't report
/// them itself. A native view that does ([ReaderController.controlsToggle])
/// must get every pointer unclaimed: a tap recognizer above an Android platform
/// view holds the gesture arena through a long press, so the WebView never
/// sees the press and text can't be selected.
class ReaderTapRouting extends StatelessWidget {
  const ReaderTapRouting({
    super.key,
    required this.engineHandlesTaps,
    required this.onTap,
    required this.child,
  });

  final bool engineHandlesTaps;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => engineHandlesTaps
      ? child
      : GestureDetector(
          behavior: HitTestBehavior.translucent,
          onTap: onTap,
          child: child,
        );
}

/// Apple-Books-style quiet corner readout while the chrome is hidden.
class _EdgeProgress extends StatelessWidget {
  const _EdgeProgress({required this.visible, required this.controller});
  final bool visible;
  final ReaderController controller;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      right: Space.gutter,
      bottom: MediaQuery.paddingOf(context).bottom + Space.sm,
      child: IgnorePointer(
        child: AnimatedOpacity(
          duration: Motion.of(context, Motion.base),
          opacity: visible ? 1 : 0,
          child: ValueListenableBuilder<ReadingLocator?>(
            valueListenable: controller.locator,
            builder: (context, loc, _) => Text(
              '${((loc?.totalProgression ?? 0) * 100).round()}%',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: context.colors.subtle,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Floats over the lower right once the reader is past the chapter's start,
/// above the bottom chrome or, while it is hidden, above the corner readout.
class _ToChapterStart extends StatelessWidget {
  const _ToChapterStart({
    required this.chromeVisible,
    required this.controller,
  });
  final bool chromeVisible;
  final ReaderController controller;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final inset = MediaQuery.paddingOf(context).bottom;
    return AnimatedPositioned(
      duration: Motion.of(context, Motion.base),
      curve: Motion.curve,
      right: Space.gutter,
      // Bottom chrome is ~65dp; the corner readout is one ~16dp label line.
      bottom:
          inset + (chromeVisible ? 65 + Space.sm : Space.sm + 16 + Space.sm),
      child: ValueListenableBuilder<ReadingLocator?>(
        valueListenable: controller.locator,
        builder: (context, loc, _) {
          final shown = (loc?.progression ?? 0) > 0.02;
          return IgnorePointer(
            ignoring: !shown,
            child: AnimatedOpacity(
              duration: Motion.of(context, Motion.base),
              curve: Motion.curve,
              opacity: shown ? 1 : 0,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.bg,
                  shape: BoxShape.circle,
                  border: Border.all(color: colors.border),
                ),
                child: QuietIconButton(
                  icon: Icons.arrow_upward,
                  label: 'Back to top',
                  onPressed: (controller as ReaderChapterStart).toChapterStart,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _TopChrome extends StatelessWidget {
  const _TopChrome({
    required this.visible,
    required this.title,
    required this.controller,
    required this.engineName,
    required this.onSettings,
    this.onHighlights,
  });
  final bool visible;
  final String title;
  final ReaderController controller;
  final String engineName;
  final VoidCallback onSettings;
  final VoidCallback? onHighlights;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Positioned(
      left: 0,
      right: 0,
      top: 0,
      child: IgnorePointer(
        ignoring: !visible,
        child: AnimatedOpacity(
          duration: Motion.of(context, Motion.base),
          curve: Motion.curve,
          opacity: visible ? 1 : 0,
          // Opaque: even 8% of the page's text stays legible on pure black.
          child: Container(
            decoration: BoxDecoration(
              color: colors.bg,
              border: Border(bottom: BorderSide(color: colors.border)),
            ),
            padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top),
            child: Row(
              children: [
                QuietIconButton(
                  icon: Icons.close,
                  label: 'Close book',
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                Expanded(
                  child: Text(
                    title,
                    style: text.titleSmall?.copyWith(color: colors.muted),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                QuietIconButton(
                  icon: Icons.format_list_bulleted,
                  label: 'Contents',
                  onPressed: () => _openContents(context),
                ),
                if (onHighlights != null)
                  QuietIconButton(
                    icon: Icons.border_color_outlined,
                    label: 'Highlights',
                    onPressed: onHighlights,
                  ),
                if (controller is ReaderSearch)
                  QuietIconButton(
                    icon: Icons.search,
                    label: 'Search book',
                    onPressed: () => showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => ReaderSearchSheet(controller: controller),
                    ),
                  ),
                QuietIconButton(
                  icon: Icons.text_fields,
                  label: 'Typography',
                  onPressed: onSettings,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openContents(BuildContext context) async {
    final toc = controller.info.toc;
    final current = controller.locator.value?.href;
    final colors = context.colors;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      barrierColor: Colors.black54,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        maxChildSize: 0.92,
        builder: (ctx, scroll) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(
                Space.gutter,
                Space.lg,
                Space.gutter,
                Space.sm,
              ),
              child: Eyebrow('Contents'),
            ),
            Expanded(
              child: ListView.builder(
                controller: scroll,
                itemCount: toc.length,
                itemBuilder: (_, i) {
                  final t = toc[i];
                  final active =
                      current != null && t.href.split('#').first == current;
                  return ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.only(
                      left: Space.gutter + t.depth * 16,
                      right: Space.gutter,
                    ),
                    title: Text(
                      t.title,
                      style: Theme.of(ctx).textTheme.bodyMedium?.copyWith(
                        fontFamily: Fonts.serif,
                        color: active ? colors.fg : colors.muted,
                        fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                      ),
                    ),
                    onTap: () {
                      Navigator.pop(ctx);
                      controller.goToHref(t.href);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BottomChrome extends StatelessWidget {
  const _BottomChrome({required this.visible, required this.controller});
  final bool visible;
  final ReaderController controller;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: IgnorePointer(
        ignoring: !visible,
        child: AnimatedOpacity(
          duration: Motion.of(context, Motion.base),
          curve: Motion.curve,
          opacity: visible ? 1 : 0,
          child: Container(
            decoration: BoxDecoration(
              color: colors.bg,
              border: Border(top: BorderSide(color: colors.border)),
            ),
            padding: EdgeInsets.fromLTRB(
              Space.sm,
              Space.sm,
              Space.sm,
              MediaQuery.paddingOf(context).bottom + Space.sm,
            ),
            child: ValueListenableBuilder<ReadingLocator?>(
              valueListenable: controller.locator,
              builder: (context, loc, _) {
                final pct = ((loc?.totalProgression ?? 0) * 100).round();
                return Row(
                  children: [
                    QuietIconButton(
                      icon: Icons.chevron_left,
                      label: 'Previous page',
                      onPressed: controller.previous,
                    ),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            loc?.title ?? '',
                            style: text.labelSmall?.copyWith(letterSpacing: 0),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 6),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(1),
                            child: LinearProgressIndicator(
                              value: (loc?.totalProgression ?? 0).clamp(0, 1),
                              minHeight: 2,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text('$pct%', style: text.labelSmall),
                        ],
                      ),
                    ),
                    QuietIconButton(
                      icon: Icons.chevron_right,
                      label: 'Next page',
                      onPressed: controller.next,
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
