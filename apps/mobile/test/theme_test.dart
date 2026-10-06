import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/core/theme/theme_presets.dart';
import 'package:thereader/core/theme/tokens.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/settings/theme_section.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

/// Theme presets: selection from Settings, persistence across restart, the
/// Default preset staying identical to the historical palette, and colours
/// reaching the chrome, the reading surface and the system bars.

Future<AppServices> makeServices(MemoryKeyValueStore kv) async {
  final settings = SettingsRepository(kv);
  await settings.load();
  final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
  await library.load();
  return AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [DartReaderEngine()]),
    catalogSource: SampleCatalogSource(),
  );
}

Finder card(String name) => find.byWidgetPredicate(
      (w) => w is ThemePreviewCard && w.preset.name == name,
    );

/// A tall surface so the whole theme grid is on screen at once.
Future<void> pumpApp(WidgetTester tester, AppServices services) async {
  tester.view.physicalSize = const Size(800, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(TheReaderApp(services: services));
  await tester.pumpAndSettle();
}

void main() {
  setUp(rootBundle.clear);

  group('presets', () {
    test('Default is the exact Vercel-dark palette and the fallback for anything unknown', () {
      expect(ThemePreset.byId(null), same(ThemePreset.fallback));
      expect(ThemePreset.byId('does-not-exist'), same(ThemePreset.fallback));
      expect(ThemePreset.fallback.id, 'default');
      final c = ThemePreset.fallback.colors;
      expect(c.bg, Palette.bg);
      expect(c.panel, Palette.panel);
      expect(c.element, Palette.element);
      expect(c.border, Palette.border);
      expect(c.borderActive, Palette.borderActive);
      expect(c.fg, Palette.fg);
      expect(c.muted, Palette.muted);
      expect(c.subtle, Palette.subtle);
      expect(c.blue, Palette.blue);
      expect(c.purple, Palette.purple);
      expect(c.green, Palette.green);
      expect(c.orange, Palette.orange);
      expect(c.pink, Palette.pink);
      expect(c.cyan, Palette.cyan);
      expect(c.paper, const Color(0xFF000000));
      expect(c.ink, Palette.fg);
      expect(c.error, Palette.error);
      expect(c.accents, [Palette.blue, Palette.purple, Palette.green, Palette.orange, Palette.cyan, Palette.pink]);
    });

    test('ids are the agreed enum, every preset is dark and readable', () {
      expect(ThemePreset.all.map((p) => p.id).toList(),
          ['default', 'dracula', 'nord', 'tokyo-night', 'catppuccin-mocha', 'gruvbox']);
      for (final p in ThemePreset.all) {
        expect(ThemePreset.byId(p.id), same(p));
        expect(ThemePreset.isKnown(p.id), isTrue);
        final c = p.colors;
        expect(c.bg.computeLuminance(), lessThan(0.05), reason: '${p.id} bg must be dark');
        expect(c.paper.computeLuminance(), lessThan(0.05), reason: '${p.id} paper must be dark');
        double contrast(Color a, Color b) {
          final la = a.computeLuminance(), lb = b.computeLuminance();
          return (la > lb ? la + 0.05 : lb + 0.05) / (la > lb ? lb + 0.05 : la + 0.05);
        }
        expect(contrast(c.fg, c.bg), greaterThan(7), reason: '${p.id} fg on bg');
        expect(contrast(c.ink, c.paper), greaterThan(7), reason: '${p.id} ink on paper');
        expect(contrast(c.muted, c.bg), greaterThan(4.5), reason: '${p.id} muted on bg');
        expect(contrast(c.fg, c.element), greaterThan(4.5), reason: '${p.id} fg on element');
        expect(contrast(c.error, c.bg), greaterThan(3), reason: '${p.id} error on bg');
      }
    });

    test('CSS hex is stable for the reader HTML styles', () {
      expect(Palette.fg.toCssHex(), '#ededed');
      expect(const Color(0xFF1A1B26).toCssHex(), '#1a1b26');
    });

    test('theme data carries the extension and the default theme matches the historical one', () {
      final theme = AppTheme.build(ThemePreset.nord.colors);
      expect(theme.extension<AppColors>(), ThemePreset.nord.colors);
      expect(theme.scaffoldBackgroundColor, ThemePreset.nord.colors.bg);
      expect(theme.brightness, Brightness.dark);
      expect(AppTheme.dark.scaffoldBackgroundColor, const Color(0xFF000000));
      expect(AppTheme.overlayFor(ThemePreset.nord.colors).systemNavigationBarColor, ThemePreset.nord.colors.bg);
      expect(AppTheme.overlayFor(AppColors.defaults), AppTheme.overlay);
    });
  });

  group('preferences', () {
    test('themeId is optional and round-trips; unknown ids survive as written', () {
      const none = ReaderPreferences();
      expect(none.themeId, isNull);
      expect(none.toJson().containsKey('themeId'), isFalse);
      expect(ReaderPreferences.fromJson(none.toJson()).themeId, isNull);

      final nord = none.copyWith(themeId: 'nord');
      expect(nord.toJson()['themeId'], 'nord');
      expect(ReaderPreferences.fromJson(nord.toJson()).themeId, 'nord');
      // A future preset chosen on another device is kept, not clobbered.
      expect(ReaderPreferences.fromJson({'themeId': 'solarized'}).themeId, 'solarized');
      expect(ThemePreset.byId('solarized').id, 'default');
    });

    test('a chosen theme persists and reloads', () async {
      final kv = MemoryKeyValueStore();
      final settings = SettingsRepository(kv);
      await settings.load();
      await settings.setThemeId('gruvbox');
      expect(settings.reader.themeId, 'gruvbox');

      final again = SettingsRepository(kv);
      await again.load();
      expect(again.reader.themeId, 'gruvbox');
      // Other reader preferences are untouched by a theme change.
      expect(again.reader.fontSize, const ReaderPreferences().fontSize);
    });
  });

  testWidgets('Settings shows every preset as a miniature, Default selected by default', (tester) async {
    final services = await makeServices(MemoryKeyValueStore());
    await pumpApp(tester, services);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    final semantics = tester.ensureSemantics();
    expect(find.text('THEME'), findsOneWidget);
    for (final p in ThemePreset.all) {
      expect(card(p.name), findsOneWidget, reason: p.name);
      expect(find.descendant(of: card(p.name), matching: find.byType(ThemeMiniature)), findsOneWidget);
      final mini = tester.widget<ThemeMiniature>(
        find.descendant(of: card(p.name), matching: find.byType(ThemeMiniature)),
      );
      // The miniature is painted in its own preset, not the active one.
      expect(mini.colors, p.colors);
      expect(tester.widget<ThemePreviewCard>(card(p.name)).selected, p.id == 'default');
    }
    expect(find.bySemanticsLabel(RegExp('Default theme')), findsOneWidget);
    expect(
      tester.getSemantics(find.bySemanticsLabel(RegExp('Default theme'))).flagsCollection.isSelected,
      Tristate.isTrue,
    );
    expect(
      tester.getSemantics(find.bySemanticsLabel(RegExp('Nord theme'))).flagsCollection.isSelected,
      Tristate.isFalse,
    );
    // Only one check mark: the selected card.
    expect(
      find.descendant(of: find.byType(ThemePreviewCard), matching: find.byIcon(Icons.check)),
      findsOneWidget,
    );
    semantics.dispose();
  });

  testWidgets('choosing a preset re-themes the app at once and survives a restart', (tester) async {
    final kv = MemoryKeyValueStore();
    final services = await makeServices(kv);
    await pumpApp(tester, services);

    Color scaffoldColor() =>
        Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor;
    expect(scaffoldColor(), const Color(0xFF000000));

    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(card('Tokyo Night'));
    await tester.pumpAndSettle();

    final tokyo = ThemePreset.tokyoNight.colors;
    expect(services.settings.reader.themeId, 'tokyo-night');
    expect(scaffoldColor(), tokyo.bg);
    expect(AppColors.of(tester.element(find.text('THEME'))), tokyo);
    expect(tester.widget<ThemePreviewCard>(card('Tokyo Night')).selected, isTrue);
    expect(tester.widget<ThemePreviewCard>(card('Default')).selected, isFalse);
    // The tab row and the API field pick up the new colours.
    final tab = tester.widget<AnimatedDefaultTextStyle>(
      find.ancestor(of: find.text('Settings').last, matching: find.byType(AnimatedDefaultTextStyle)).first,
    );
    expect(tab.style.color, tokyo.fg);
    final input = Theme.of(tester.element(find.byType(TextField))).inputDecorationTheme;
    expect(input.fillColor, tokyo.panel);
    // System bars follow the preset.
    final region = tester.widget<AnnotatedRegion<SystemUiOverlayStyle>>(
      find.byType(AnnotatedRegion<SystemUiOverlayStyle>).first,
    );
    expect(region.value.systemNavigationBarColor, tokyo.bg);

    // Restart: a fresh app over the same store opens already themed.
    await tester.pumpWidget(const SizedBox());
    services.dispose();
    final restarted = await makeServices(kv);
    await pumpApp(tester, restarted);
    expect(restarted.settings.reader.themeId, 'tokyo-night');
    expect(scaffoldColor(), tokyo.bg);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(tester.widget<ThemePreviewCard>(card('Tokyo Night')).selected, isTrue);

    // Back to Default restores pure black.
    await tester.tap(card('Default'));
    await tester.pumpAndSettle();
    expect(restarted.settings.reader.themeId, 'default');
    expect(scaffoldColor(), const Color(0xFF000000));
  });

  testWidgets('a preset set outside the picker applies without any tap', (tester) async {
    final services = await makeServices(MemoryKeyValueStore());
    await pumpApp(tester, services);
    await services.settings.setThemeId('catppuccin-mocha');
    await tester.pumpAndSettle();
    expect(
      Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor,
      ThemePreset.catppuccinMocha.colors.bg,
    );
  });

  group('reading surface', () {
    test('Dart engine HTML styles use the preset paper and ink, not fixed hex', () {
      const prefs = ReaderPreferences();
      final def = DartReaderView.stylesFor('h1', prefs, AppColors.defaults)!;
      expect(def['color'], '#ededed');
      final nord = ThemePreset.nord.colors;
      expect(DartReaderView.stylesFor('h1', prefs, nord)!['color'], nord.ink.toCssHex());
      expect(DartReaderView.stylesFor('a', prefs, nord)!['color'], nord.primary.toCssHex());
      expect(DartReaderView.stylesFor('pre', prefs, nord)!['background-color'], nord.panel.toCssHex());
      expect(DartReaderView.stylesFor('hr', prefs, nord)!['border-color'], nord.border.toCssHex());
      expect(DartReaderView.stylesFor('blockquote', prefs, nord)!['color'], nord.muted.toCssHex());
      expect(DartReaderView.stylesFor('p', prefs.copyWith(justify: true), nord)!['text-align'], 'justify');
    });

    testWidgets('the open reader repaints its canvas when the theme changes', (tester) async {
      final services = await makeServices(MemoryKeyValueStore());
      await pumpApp(tester, services);
      await tester.tap(find.text('Browse'));
      await tester.pumpAndSettle();
      await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data == 'The Quiet Hour' && w.maxLines == 1));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Download ·'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Read'));
      await tester.pumpAndSettle();
      expect(find.byType(DartReaderView), findsOneWidget);

      Color canvas() => (tester.widget<ColoredBox>(
            find.descendant(of: find.byType(DartReaderView), matching: find.byType(ColoredBox)).first,
          )).color;
      expect(canvas(), const Color(0xFF000000));
      final body = find.descendant(of: find.byType(DartReaderView), matching: find.byType(RichText)).first;
      expect(tester.widget<RichText>(body).text.style?.color, Palette.fg);

      await services.settings.setThemeId('gruvbox');
      await tester.pumpAndSettle();
      final gruv = ThemePreset.gruvbox.colors;
      expect(canvas(), gruv.paper);
      final body2 = find.descendant(of: find.byType(DartReaderView), matching: find.byType(RichText)).first;
      expect(tester.widget<RichText>(body2).text.style?.color, gruv.ink);
      expect(
        tester.widget<Scaffold>(find.ancestor(of: find.byType(DartReaderView), matching: find.byType(Scaffold))).backgroundColor,
        gruv.paper,
      );
      Navigator.of(tester.element(find.byType(DartReaderView))).pop();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  });
}
