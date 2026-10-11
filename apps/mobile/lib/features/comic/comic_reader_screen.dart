import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/library.dart';
import '../../data/storage/book_store.dart';
import '../../reader/comic/comic_archive.dart';
import '../../reader/comic/comic_layout.dart';
import '../../reader/comic/comic_page_store.dart';
import '../shared/states.dart';
import 'comic_reader_view.dart';

/// Reads a CBZ page by page. Reached through [ReaderScreen.open], which picks
/// this screen for comics. Position and reading time ride the same paths as
/// books; there are no highlights, typography or contents for comics.
class ComicReaderScreen extends StatefulWidget {
  const ComicReaderScreen({super.key, required this.entry});

  final LibraryEntry entry;

  /// Image decoding override: widget tests can't decode real images inside
  /// their fake-async zone.
  @visibleForTesting
  static ComicPageDecoder? debugDecoder;

  @override
  State<ComicReaderScreen> createState() => _ComicReaderScreenState();
}

class _ComicReaderScreenState extends State<ComicReaderScreen> with WidgetsBindingObserver {
  late AppServices _services;
  final ComicViewController _view = ComicViewController();
  ComicArchive? _archive;
  ComicPageStore? _store;
  int _initialPage = 0;

  /// First visible page once the view has laid out.
  int? _page;
  String? _error;
  bool _chromeVisible = false;
  bool _provisional = false;
  bool _listeningLibrary = false;
  bool _swappingFile = false;
  bool _reading = false;
  Timer? _saveDebounce;
  AppColors _colors = AppColors.defaults;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    _view.addListener(_onPage);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _open();
    });
  }

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
      setState(() => _error = 'This comic has not been downloaded.');
      return;
    }
    BookFile? file;
    try {
      file = await services.library.openForReading(widget.entry.id);
      _provisional = file.isProvisional;
      final archive = await ComicArchive.open(file);
      if (!mounted) {
        await archive.close();
        return;
      }
      final store = ComicPageStore.forArchive(
        archive,
        decode: ComicReaderScreen.debugDecoder,
      );
      _initialPage = comicPageFromLocator(archive.pages, widget.entry.progress?.locator);
      unawaited(
        services.library.markOpened(widget.entry.id, expectedSha256: widget.entry.book.sha256),
      );
      setState(() {
        _archive = archive;
        _store = store;
      });
      services.sync?.beginReading(widget.entry);
      _reading = true;
      // Record the opening position so "Continue reading" appears immediately.
      _onPage();
    } catch (e) {
      await file?.close();
      if (mounted) {
        setState(() => _error = e is ComicFormatException ? e.message : e.toString());
      }
    }
  }

  bool get _streamStillValid {
    final entry = _services.library.entry(widget.entry.id);
    return entry?.book.sha256 == widget.entry.book.sha256 &&
        _services.library.canRead(widget.entry.id);
  }

  void _onDownloadChange() {
    final archive = _archive;
    if (!_provisional || archive == null || !mounted) return;
    if (!_streamStillValid) {
      _provisional = false;
      _endReading();
      _saveNow();
      setState(() => _error = 'The download stopped. Return to your library to retry.');
      return;
    }
    // Same bytes, now verified on disk: read the rest from the local copy.
    if (_services.library.entry(widget.entry.id)?.download.isReady == true && !_swappingFile) {
      _swappingFile = true;
      unawaited(() async {
        try {
          final file = await _services.library.openForReading(widget.entry.id);
          if (file.isProvisional || !mounted || _archive != archive) {
            await file.close();
            return;
          }
          await archive.replaceFile(file);
          _provisional = false;
        } catch (_) {
          // Keep streaming; the next library change tries again.
        } finally {
          _swappingFile = false;
        }
      }());
    }
  }

  void _onPage() {
    if (_archive == null) return;
    if (_view.pageCount > 0) _page = _view.firstPage;
    if (mounted) setState(() {});
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 600), _saveNow);
  }

  ReadingLocator? get _locator {
    final archive = _archive;
    if (archive == null) return null;
    return comicLocator(archive.pages, _page ?? _initialPage);
  }

  void _saveNow() {
    final loc = _locator;
    if (loc == null || !mounted) return;
    _services.library.saveProgress(widget.entry.id, loc, expectedSha256: widget.entry.book.sha256);
  }

  void _endReading() {
    if (!_reading) return;
    _reading = false;
    final sync = _services.sync;
    Future.microtask(() => sync?.endReading());
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
    _endReading();
    _saveDebounce?.cancel();
    final loc = _error == null ? _locator : null;
    if (loc != null) {
      // Dispose runs while the tree is locked; notify listeners afterwards.
      final services = _services;
      final id = widget.entry.id;
      final expectedSha256 = widget.entry.book.sha256;
      Future.microtask(
        () => services.library.saveProgress(id, loc, expectedSha256: expectedSha256),
      );
    }
    if (_listeningLibrary) _services.library.removeListener(_onDownloadChange);
    _view.removeListener(_onPage);
    _view.dispose();
    _store?.dispose();
    unawaited(_archive?.close());
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(AppTheme.overlayFor(_colors));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final store = _store;
    Widget body;
    if (_error != null) {
      body = SafeArea(
        child: StateMessage(
          title: "Couldn't open this comic.",
          body: _error,
          error: true,
          actionLabel: 'Back',
          onAction: () => Navigator.of(context).maybePop(),
        ),
      );
    } else if (store == null) {
      body = const SafeArea(child: LoadingLine(label: 'Opening'));
    } else {
      body = Stack(
        children: [
          Positioned.fill(
            child: ComicReaderView(
              store: store,
              controller: _view,
              initialPage: _initialPage,
              onCenterTap: () => setState(() => _chromeVisible = !_chromeVisible),
              onTurn: () {
                if (_chromeVisible) setState(() => _chromeVisible = false);
              },
            ),
          ),
          _ComicTopChrome(visible: _chromeVisible, title: widget.entry.book.title),
          _ComicBottomChrome(visible: _chromeVisible, controller: _view),
          if (_provisional)
            Positioned(
              left: Space.gutter,
              // Floats just above the bottom chrome (~90dp with the slider).
              bottom: MediaQuery.paddingOf(context).bottom + 90 + Space.sm,
              child: IgnorePointer(
                child: AnimatedBuilder(
                  animation: _services.library,
                  builder: (context, _) {
                    final download = _services.library.entry(widget.entry.id)?.download;
                    if (!_chromeVisible || download?.isActive != true) {
                      return const SizedBox.shrink();
                    }
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: colors.bg,
                        borderRadius: const BorderRadius.all(Radii.sm),
                      ),
                      child: Text(
                        'Downloading · ${((download?.fraction ?? 0) * 100).floor()}%',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: colors.muted),
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
      backgroundColor: Palette.bg,
      body: AnnotatedRegion<SystemUiOverlayStyle>(
        value: AppTheme.overlayFor(colors),
        child: body,
      ),
    );
  }
}

class _ComicTopChrome extends StatelessWidget {
  const _ComicTopChrome({required this.visible, required this.title});
  final bool visible;
  final String title;

  @override
  Widget build(BuildContext context) {
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
                  label: 'Close comic',
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(color: colors.muted),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: Space.md),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "Page X of N" (or "X–Y of N" for a spread) and a slider to jump.
class _ComicBottomChrome extends StatefulWidget {
  const _ComicBottomChrome({required this.visible, required this.controller});
  final bool visible;
  final ComicViewController controller;

  @override
  State<_ComicBottomChrome> createState() => _ComicBottomChromeState();
}

class _ComicBottomChromeState extends State<_ComicBottomChrome> {
  /// The page under the slider thumb while it is being dragged.
  int? _scrub;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final c = widget.controller;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: IgnorePointer(
        ignoring: !widget.visible,
        child: AnimatedOpacity(
          duration: Motion.of(context, Motion.base),
          curve: Motion.curve,
          opacity: widget.visible ? 1 : 0,
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
            child: ListenableBuilder(
              listenable: c,
              builder: (context, _) {
                final count = c.pageCount;
                final scrub = _scrub;
                final label = scrub != null
                    ? 'Page ${scrub + 1} of $count'
                    : comicPageLabel(c.firstPage, c.lastPage, count);
                return Row(
                  children: [
                    QuietIconButton(
                      icon: Icons.chevron_left,
                      label: 'Previous page',
                      onPressed: c.previous,
                    ),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            label,
                            style: text.labelSmall?.copyWith(
                              letterSpacing: 0,
                              fontFeatures: const [FontFeature.tabularFigures()],
                            ),
                          ),
                          if (count > 1)
                            Slider(
                              value: (scrub ?? c.firstPage).clamp(0, count - 1).toDouble(),
                              max: (count - 1).toDouble(),
                              divisions: count - 1,
                              semanticFormatterCallback: (v) => 'Page ${v.round() + 1} of $count',
                              onChanged: (v) => setState(() => _scrub = v.round()),
                              onChangeEnd: (v) {
                                setState(() => _scrub = null);
                                c.jumpTo(v.round());
                              },
                            )
                          else
                            const SizedBox(height: Space.sm),
                        ],
                      ),
                    ),
                    QuietIconButton(
                      icon: Icons.chevron_right,
                      label: 'Next page',
                      onPressed: c.next,
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

/// "Page 3 of 20", or "4–5 of 20" when a spread shows two pages.
String comicPageLabel(int first, int last, int count) =>
    first == last ? 'Page ${first + 1} of $count' : '${first + 1}–${last + 1} of $count';
