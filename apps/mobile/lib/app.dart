import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_scope.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/tokens.dart';
import 'features/catalog/catalog_screen.dart';
import 'features/library/library_screen.dart';
import 'features/settings/settings_screen.dart';

class TheReaderApp extends StatelessWidget {
  const TheReaderApp({super.key, required this.services});

  final AppServices services;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      services: services,
      child: MaterialApp(
        title: 'The Reader',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark,
        darkTheme: AppTheme.dark,
        themeMode: ThemeMode.dark,
        home: const HomeShell(),
      ),
    );
  }
}

/// Three quiet destinations. A text tab row instead of a Material bar keeps
/// the chrome light; hit targets stay at 44pt.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      LibraryScreen(onBrowse: () => setState(() => _index = 1)),
      CatalogScreen(onOpenSettings: () => setState(() => _index = 2)),
      const SettingsScreen(),
    ];
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: AppTheme.overlay,
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
        bottomNavigationBar: _TabRow(index: _index, onChanged: (i) => setState(() => _index = i)),
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
    return Container(
      decoration: const BoxDecoration(color: Palette.bg, border: Border(top: BorderSide(color: Palette.border))),
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
                        style: text.labelLarge!.copyWith(color: i == index ? Palette.fg : Palette.subtle),
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
