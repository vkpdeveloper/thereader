import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app_scope.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/library.dart';
import '../../reader/engine/reader_engine.dart';
import '../shared/states.dart';
import 'reader_settings_sheet.dart';

/// The reading surface. Chrome is hidden by default and revealed with a tap;
/// position is saved continuously and on exit.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({super.key, required this.entry});

  final LibraryEntry entry;

  static Future<void> open(BuildContext context, LibraryEntry entry) => Navigator.of(context).push(
        PageRouteBuilder(
          transitionDuration: Motion.of(context, Motion.slow),
          reverseTransitionDuration: Motion.of(context, Motion.base),
          pageBuilder: (_, _, _) => ReaderScreen(entry: entry),
          transitionsBuilder: (_, anim, _, child) =>
              FadeTransition(opacity: CurvedAnimation(parent: anim, curve: Motion.curve), child: child),
        ),
      );

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  late final AppServices _services;
  ReaderController? _controller;
  ReaderEngine? _engine;
  String? _error;
  String? _fallbackNote;
  bool _chromeVisible = false;
  Timer? _saveDebounce;

  @override
  void initState() {
    super.initState();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _services = AppScope.of(context);
  }

  Future<void> _open() async {
    final services = _services;
    final path = widget.entry.download.path;
    if (path == null) {
      setState(() => _error = 'This book has not been downloaded.');
      return;
    }
    try {
      final candidates = services.readerService.candidates(services.settings.settings.preferredEngine);
      ReaderEngine? engine;
      ReaderController? controller;
      Object? firstError;
      for (final candidate in candidates) {
        final file = await services.library.bookStore.open(path);
        try {
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
      if (engine == null || controller == null) throw firstError ?? StateError('No engine could open the book.');
      if (engine.id != candidates.first.id) {
        _fallbackNote = '${candidates.first.availability.name} could not open this book; using ${engine.availability.name}.';
      }
      controller.locator.addListener(_onLocator);
      controller.controlsToggle?.addListener(_onEngineControls);
      services.settings.addListener(_onPrefs);
      unawaited(services.library.markOpened(widget.entry.id));
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
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(note), duration: const Duration(seconds: 5)));
      }
      // Record the opening position so "Continue reading" appears immediately.
      _onLocator();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  void _onPrefs() => _controller?.applyPreferences(_services.settings.reader);

  void _onEngineControls() {
    final v = _controller?.controlsToggle?.value;
    if (v != null && v != _chromeVisible && mounted) setState(() => _chromeVisible = v);
  }

  void _onLocator() {
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 600), _saveNow);
  }

  void _saveNow() {
    final loc = _controller?.locator.value;
    if (loc == null || !mounted) return;
    _services.library.saveProgress(widget.entry.id, loc);
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
    final loc = _controller?.locator.value;
    if (loc != null) {
      // Dispose runs while the tree is locked; notify listeners afterwards.
      final services = _services;
      final id = widget.entry.id;
      Future.microtask(() => services.library.saveProgress(id, loc));
    }
    _services.settings.removeListener(_onPrefs);
    _controller?.locator.removeListener(_onLocator);
    _controller?.controlsToggle?.removeListener(_onEngineControls);
    _controller?.dispose();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(AppTheme.overlay);
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
    Widget body;
    if (_error != null) {
      body = SafeArea(
        child: StateMessage(
          title: "Couldn't open this book.",
          body: _error,
          tone: Palette.error,
          actionLabel: 'Back',
          onAction: () => Navigator.of(context).maybePop(),
        ),
      );
    } else if (controller == null) {
      body = const SafeArea(child: LoadingLine(label: 'Opening'));
    } else {
      body = Stack(
        children: [
          GestureDetector(
            behavior: HitTestBehavior.translucent,
            onTap: _toggleChrome,
            child: _engine!.buildView(context, controller),
          ),
          _EdgeProgress(visible: !_chromeVisible, controller: controller),
          _TopChrome(visible: _chromeVisible, title: widget.entry.book.title, controller: controller,
              engineName: _engine!.availability.name, onSettings: () => _openSettings(controller)),
          _BottomChrome(visible: _chromeVisible, controller: controller),
        ],
      );
    }
    return Scaffold(
      backgroundColor: Palette.bg,
      body: AnnotatedRegion<SystemUiOverlayStyle>(value: AppTheme.overlay, child: body),
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
              style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Palette.subtle, fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ),
        ),
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
  });
  final bool visible;
  final String title;
  final ReaderController controller;
  final String engineName;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
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
            color: Palette.bg.withValues(alpha: 0.92),
            padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top),
            child: Row(
              children: [
                QuietIconButton(icon: Icons.close, label: 'Close book', onPressed: () => Navigator.of(context).maybePop()),
                Expanded(
                  child: Text(title, style: text.titleSmall?.copyWith(color: Palette.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
                QuietIconButton(icon: Icons.format_list_bulleted, label: 'Contents', onPressed: () => _openContents(context)),
                QuietIconButton(icon: Icons.text_fields, label: 'Typography', onPressed: onSettings),
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
              padding: EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, Space.sm),
              child: Eyebrow('Contents'),
            ),
            Expanded(
              child: ListView.builder(
                controller: scroll,
                itemCount: toc.length,
                itemBuilder: (_, i) {
                  final t = toc[i];
                  final active = current != null && t.href.split('#').first == current;
                  return ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.only(left: Space.gutter + t.depth * 16, right: Space.gutter),
                    title: Text(
                      t.title,
                      style: Theme.of(ctx).textTheme.bodyMedium?.copyWith(
                            fontFamily: Fonts.serif,
                            color: active ? Palette.fg : Palette.muted,
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
            color: Palette.bg.withValues(alpha: 0.92),
            padding: EdgeInsets.fromLTRB(Space.sm, Space.sm, Space.sm, MediaQuery.paddingOf(context).bottom + Space.sm),
            child: ValueListenableBuilder<ReadingLocator?>(
              valueListenable: controller.locator,
              builder: (context, loc, _) {
                final pct = ((loc?.totalProgression ?? 0) * 100).round();
                return Row(
                  children: [
                    QuietIconButton(icon: Icons.chevron_left, label: 'Previous chapter', onPressed: controller.previous),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(loc?.title ?? '', style: text.labelSmall?.copyWith(letterSpacing: 0), maxLines: 1, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 6),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(1),
                            child: LinearProgressIndicator(value: (loc?.totalProgression ?? 0).clamp(0, 1), minHeight: 2),
                          ),
                          const SizedBox(height: 4),
                          Text('$pct%', style: text.labelSmall),
                        ],
                      ),
                    ),
                    QuietIconButton(icon: Icons.chevron_right, label: 'Next chapter', onPressed: controller.next),
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
