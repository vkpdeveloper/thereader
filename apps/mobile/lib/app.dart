import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_scope.dart';
import 'core/theme/app_colors.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_presets.dart';
import 'core/theme/tokens.dart';
import 'features/catalog/catalog_screen.dart';
import 'features/library/library_screen.dart';
import 'features/settings/settings_screen.dart';
import 'data/import/import_platform.dart' as import_platform;
import 'features/reader/reader_screen.dart';

class TheReaderApp extends StatelessWidget {
  const TheReaderApp({super.key, required this.services, this.libraryReady});

  final AppServices services;
  final Future<void>? libraryReady;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      services: services,
      // The theme follows the saved preset; rebuilding MaterialApp's theme
      // re-themes every open route, sheet and dialog at once.
      child: ListenableBuilder(
        listenable: services.settings,
        builder: (context, _) {
          final preset = ThemePreset.byId(services.settings.reader.themeId);
          final theme = AppTheme.build(preset.colors);
          return MaterialApp(
            title: 'The Reader',
            debugShowCheckedModeBanner: false,
            theme: theme,
            darkTheme: theme,
            themeMode: ThemeMode.dark,
            themeAnimationDuration: Motion.base,
            themeAnimationCurve: Motion.curve,
            home: HomeShell(libraryReady: libraryReady),
          );
        },
      ),
    );
  }
}

/// Three quiet destinations. A text tab row instead of a Material bar keeps
/// the chrome light; hit targets stay at 44pt.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.libraryReady});

  final Future<void>? libraryReady;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  static const _openChannel = MethodChannel('thereader/open_epub');
  int _index = 0;
  bool _draining = false;
  bool _drainAgain = false;

  @override
  void initState() {
    super.initState();
    _openChannel.setMethodCallHandler((call) async {
      if (call.method == 'filesReady') unawaited(_drainExternalBooks());
    });
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => unawaited(_drainExternalBooks()),
    );
  }

  @override
  void dispose() {
    _openChannel.setMethodCallHandler(null);
    super.dispose();
  }

  Future<void> _drainExternalBooks() async {
    if (_draining) {
      _drainAgain = true;
      return;
    }
    _draining = true;
    try {
      do {
        _drainAgain = false;
        final List<dynamic> items;
        try {
          items =
              await _openChannel.invokeListMethod<dynamic>('getPending') ?? [];
        } on MissingPluginException {
          return;
        }
        await widget.libraryReady;
        if (!mounted) return;
        final imports = AppScope.of(context).imports;
        for (final item in items) {
          if (!mounted) return;
          final data = (item as Map).cast<String, dynamic>();
          final path = data['path'] as String?;
          if (path == null) {
            _showOpenError(
              data['error'] as String? ?? 'Could not open this EPUB.',
            );
            continue;
          }
          try {
            if (imports == null) {
              _showOpenError('EPUB import is unavailable.');
              continue;
            }
            if (imports.busy) {
              final ready = Completer<void>();
              void listener() {
                if (!imports.busy && !ready.isCompleted) ready.complete();
              }

              imports.addListener(listener);
              try {
                listener();
                await ready.future;
              } finally {
                imports.removeListener(listener);
              }
            }
            final entry = await imports.importPath(path);
            if (!mounted) return;
            if (entry == null) {
              _showOpenError(imports.error ?? 'Could not import this EPUB.');
            } else {
              await ReaderScreen.openExternal(context, entry);
            }
          } finally {
            try {
              await import_platform.cleanPickedEpub(path);
            } catch (_) {
              // The local library copy is already durable; cache cleanup can
              // be retried by the OS without hiding the next incoming book.
            }
          }
        }
      } while (_drainAgain);
    } catch (error) {
      if (mounted) _showOpenError('Could not open this EPUB.');
    } finally {
      _draining = false;
    }
  }

  void _showOpenError(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      LibraryScreen(onBrowse: () => setState(() => _index = 1)),
      CatalogScreen(onOpenSettings: () => setState(() => _index = 2)),
      const SettingsScreen(),
    ];
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: AppTheme.overlayOf(context),
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: AnimatedSwitcher(
            duration: Motion.of(context, Motion.base),
            switchInCurve: Motion.curve,
            switchOutCurve: Motion.curve,
            child: KeyedSubtree(key: ValueKey(_index), child: pages[_index]),
          ),
        ),
        bottomNavigationBar: _TabRow(
          index: _index,
          onChanged: (i) => setState(() => _index = i),
        ),
      ),
    );
  }
}

class _TabRow extends StatelessWidget {
  const _TabRow({required this.index, required this.onChanged});
  final int index;
  final ValueChanged<int> onChanged;

  static const _labels = ['Library', 'Browse', 'Settings'];

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: colors.bg,
        border: Border(top: BorderSide(color: colors.border)),
      ),
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      child: Row(
        children: [
          for (var i = 0; i < _labels.length; i++)
            Expanded(
              child: Semantics(
                button: true,
                selected: i == index,
                label: _labels[i],
                child: InkWell(
                  onTap: () => onChanged(i),
                  child: SizedBox(
                    height: 50,
                    child: Center(
                      child: AnimatedDefaultTextStyle(
                        duration: Motion.of(context, Motion.fast),
                        style: text.labelLarge!.copyWith(
                          color: i == index ? colors.fg : colors.subtle,
                        ),
                        child: Text(_labels[i]),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
