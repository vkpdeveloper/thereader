import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/core/theme/theme_presets.dart';
import 'package:thereader/core/typography/reader_fonts.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/reader/reader_font_picker.dart';
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';
import 'package:xml/xml.dart';

/// Reading fonts (ids, legacy compatibility, bundled files, picker) and the
/// theme enforcement that keeps publisher colours from overriding presets.
final bool _hasNode = () {
  try {
    return Process.runSync('node', ['--version']).exitCode == 0;
  } on ProcessException {
    return false;
  }
}();

void main() {
  group('font preferences stay compatible with older clients', () {
    test('existing users keep their default and legacy class', () {
      const p = ReaderPreferences();
      expect(p.fontFamilyId, isNull);
      expect(p.toJson().containsKey('fontFamilyId'), isFalse);
      expect(ReaderFonts.resolve(p), same(ReaderFonts.systemSerif));
      expect(ReaderFonts.resolve(p.copyWith(font: ReaderFont.sans)), same(ReaderFonts.systemSans));
    });

    test('every choice syncs only serif or sans as the legacy font', () {
      for (final f in ReaderFonts.all) {
        final json = ReaderFonts.select(const ReaderPreferences(), f).toJson();
        expect(json['font'], anyOf('serif', 'sans'), reason: f.id);
        expect(json['fontFamilyId'], f.id);
        // What an older client's `ReaderFont.values.byName` would do.
        expect(() => ReaderFont.values.byName(json['font'] as String), returnsNormally);
        final back = ReaderPreferences.fromJson(json);
        expect(ReaderFonts.resolve(back), same(f));
      }
    });

    test('decoding tolerates unknown values and keeps unknown ids', () {
      final p = ReaderPreferences.fromJson({
        'font': 'literata',
        'flow': 'spread',
        'fontFamilyId': 'future-serif-2',
      });
      expect(p.font, ReaderFont.serif);
      expect(p.flow, ReaderFlow.scrolled);
      expect(p.fontFamilyId, 'future-serif-2');
      expect(p.toJson()['fontFamilyId'], 'future-serif-2');
      expect(ReaderFonts.resolve(p), same(ReaderFonts.systemSerif));
      expect(ReaderPreferences.fromJson({'fontFamilyId': 7}).fontFamilyId, isNull);
    });

    test('an older client switching the class overrides a stale id', () {
      final chosen = ReaderFonts.select(const ReaderPreferences(), ReaderFonts.inter);
      // Older builds only know `font`; the server keeps the id.
      final older = ReaderPreferences.fromJson({...chosen.toJson(), 'font': 'serif'});
      expect(ReaderFonts.resolve(older), same(ReaderFonts.systemSerif));
    });

    test('the repository persists a choice', () async {
      final store = MemoryKeyValueStore();
      final repo = SettingsRepository(store);
      await repo.load();
      await repo.setFontFamily(ReaderFonts.lexend);
      final reloaded = SettingsRepository(store);
      await reloaded.load();
      expect(reloaded.reader.font, ReaderFont.sans);
      expect(ReaderFonts.resolve(reloaded.reader), same(ReaderFonts.lexend));
    });
  });

  group('bundled fonts', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();

    test('the catalogue offers 4-6 bundled families plus system serif and sans', () {
      expect(ReaderFonts.bundled.length, inInclusiveRange(4, 6));
      expect(ReaderFonts.all, containsAll([ReaderFonts.systemSerif, ReaderFonts.systemSans]));
      expect(ReaderFonts.all.map((f) => f.id).toSet().length, ReaderFonts.all.length);
      expect(ReaderFonts.all.where((f) => f.recommended), hasLength(1));
      for (final f in ReaderFonts.all) {
        expect(RegExp(r'^[a-z0-9][a-z0-9-]{0,63}$').hasMatch(f.id), isTrue, reason: f.id);
      }
    });

    test('every bundled face exists, is a Flutter font and has a licence', () {
      for (final f in ReaderFonts.bundled) {
        expect(RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(f.cssFamily!), isTrue, reason: 'unquoted CSS name');
        expect(pubspec, contains('- family: ${f.cssFamily}\n'));
        for (final face in f.faces) {
          expect(File(face.asset).existsSync(), isTrue, reason: face.asset);
          expect(pubspec, contains('- asset: ${face.asset}\n'), reason: face.asset);
          expect(face.minWeight, lessThanOrEqualTo(face.maxWeight));
        }
        final licence = 'assets/fonts/${f.cssFamily}OFL.txt';
        expect(File(licence).readAsStringSync(), contains('SIL Open Font License'), reason: licence);
        expect(pubspec, contains('- $licence\n'));
      }
    });

    test('Readium receives a single declared family name, never a list', () {
      final colors = ThemePreset.gruvbox.colors;
      for (final f in ReaderFonts.all) {
        final prefs = ReaderFonts.select(const ReaderPreferences(), f);
        final epub = ReadiumReaderController.toEpubPreferences(prefs, colors);
        expect(epub.fontFamily, f.readiumFamily);
        expect(epub.fontFamily, isNot(contains(',')));
      }
      expect(ReadiumReaderController.toEpubPreferences(const ReaderPreferences(), colors).fontFamily, 'serif');
      final declared = ReadiumReaderController.readiumFontFamilies;
      expect(declared.map((d) => d['name']), ReaderFonts.bundled.map((f) => f.cssFamily));
      expect(declared.first['fallback'], 'serif');
      expect((declared.first['faces'] as List).first, {
        'asset': 'assets/fonts/Literata.ttf',
        'style': 'normal',
        'minWeight': 200,
        'maxWeight': 900,
      });
    });

    test('Android serves bundled faces same-origin, never from the CORS-less assets host', () {
      const android = 'vendor/flutter_readium/android/src/main/kotlin/dk/nota/flutterreadium';
      final fonts = File('$android/HostFontFamilies.kt').readAsStringSync();
      final reader = File('$android/ReadiumReader.kt').readAsStringSync();
      final fragment = File('$android/fragments/EpubReaderFragment.kt').readAsStringSync();
      // Sources are absolute package-origin URLs; a relative source would
      // resolve against https://readium_assets/, whose faces Chromium blocks.
      expect(fonts, contains(r'addSource(AbsoluteUrl("https://$PACKAGE_HOST/$FONT_PATH${fileName(face)}")!!)'));
      expect(fonts, contains('PACKAGE_HOST = "readium_package"'));
      expect(fonts, isNot(contains('addSource("')));
      expect(fragment, isNot(contains('assets/fonts')));
      // Only declared files are answered; everything else is the EPUB's.
      expect(fonts, contains('if (!declared) return inner[url]'));
      expect(fonts, contains('"flutter_assets/assets/fonts/\$file"'));
      expect(reader, contains('container = HostFontContainer(container, context.assets) { hostFontFamilies }'));
      // No global WebView relaxation.
      for (final src in [fonts, reader, fragment]) {
        expect(src, isNot(contains('allowUniversalAccessFromFileURLs')));
        expect(src, isNot(contains('Access-Control-Allow-Origin')));
      }
      // Every bundled file name fits the Kotlin validator.
      final asset = RegExp(r'^assets/fonts/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$');
      for (final f in ReaderFonts.bundled) {
        for (final face in f.faces) {
          expect(asset.hasMatch(face.asset), isTrue, reason: face.asset);
        }
      }
    });

    test('system families name a real platform family, not the app font', () {
      expect(ReaderFonts.systemSerif.flutterFamily, 'serif');
      expect(ReaderFonts.systemSans.flutterFamily, 'sans-serif');
      expect(ReaderFonts.systemSans.flutterFallback, isNotEmpty);
      expect(ReaderFonts.literata.flutterFamily, 'Literata');
    });
  });

  group('theme enforcement', () {
    const helpers = 'vendor/flutter_readium/assets/helpers';
    final css = File('$helpers/flutterReadiumTools.css').readAsStringSync();
    final js = File('$helpers/thereaderTheme.js').readAsStringSync();
    final fixture = File('test/fixtures/publisher_colors.xhtml').readAsStringSync();
    final patch = css.substring(css.indexOf('THEREADER PATCH: theme enforcement'));

    int idCount(String selector) => RegExp(r'#[A-Za-z_-]').allMatches(selector).length;

    test('boosted rules outrank the fixture publisher selectors, headings included', () {
      final publisher = RegExp(r'([^{}]+)\{[^}]*\}').allMatches(fixture.split('<style>')[1].split('</style>')[0]);
      final maxPublisherIds = publisher.map((m) => idCount(m[1]!)).reduce((a, b) => a > b ? a : b);
      final rules = RegExp(r'([^{}/]+)\{([^}]*)\}').allMatches(patch).toList();
      final colorRule = rules.firstWhere((m) => m[2]!.contains('color: inherit !important'));
      for (final selector in colorRule[1]!.split(RegExp(r',\s*\n'))) {
        expect(idCount(selector), greaterThan(maxPublisherIds), reason: selector);
        // Unlike ReadiumCSS, no heading or pre is excluded.
        expect(selector, isNot(contains(':not(h1)')));
        expect(selector, isNot(contains(':not(pre)')));
        expect(selector, contains('--USER__textColor'));
        expect(selector, contains('body:not(.flutter-readium-spotlight-active)'));
      }
      expect(colorRule[2], contains('-webkit-text-fill-color: currentColor !important'));
      expect(colorRule[2], contains('border-color: color-mix('));
      expect(colorRule[2], contains('text-shadow: none !important'));
      final background = rules.firstWhere((m) => m[2]!.contains('background-color: transparent !important'));
      final backgroundSelectors = background[1]!.split(RegExp(r',\s*\n'));
      for (final selector in backgroundSelectors) {
        expect(idCount(selector), greaterThan(maxPublisherIds), reason: selector);
      }
      // The body itself, not only its descendants (inline body backgrounds).
      expect(backgroundSelectors.first.trim(), endsWith(' body'));
      for (final excluded in ['[id^="r2-decoration-"]', 'img', 'svg', 'video', 'canvas', '.nota-comicbook-page-container']) {
        expect(background[1], contains(excluded));
      }
      // Fonts, weights, styles and layout are left to the publisher/Readium.
      final declarations = rules.map((m) => m[2]!).join();
      for (final untouched in ['font-family', 'font-weight', 'font-style', 'padding', 'margin', 'display', 'width', 'height', 'filter']) {
        expect(declarations, isNot(contains('$untouched:')), reason: untouched);
      }
    });

    test('inline !important demotion is one-shot and skips decorations', () {
      expect(js, contains('getPropertyPriority'));
      expect(js, contains('[id^="r2-decoration-"]'));
      for (final unbounded in ['MutationObserver', 'requestAnimationFrame', 'setInterval', 'setTimeout']) {
        expect(js, isNot(contains(unbounded)));
      }
      final android = File('vendor/flutter_readium/android/src/main/kotlin/dk/nota/flutterreadium/ReadiumExtensions.kt')
          .readAsStringSync();
      final ios = File('vendor/flutter_readium/ios/flutter_readium/Sources/flutter_readium/reader/EPUBReaderView+JSBridge.swift')
          .readAsStringSync();
      expect(android, contains('assets/helpers/thereaderTheme.js'));
      expect(ios, contains('assets/helpers/thereaderTheme.js'));
    });

    // Runs the real script in Node against a DOM built from the fixture.
    test('inline !important demotion covers html and body but spares artwork and decorations', () {
      Map<String, Object> node(XmlElement e) => {
            'tag': e.name.local.toLowerCase(),
            'attrs': {for (final a in e.attributes) if (a.name.prefix == null && a.name.local != 'xmlns') a.name.local: a.value},
            'children': [for (final c in e.childElements) node(c)],
          };
      final tree = node(XmlDocument.parse(fixture).rootElement);
      // Readium's live variables on <html>, and a highlight layer it injects.
      final attrs = tree['attrs']! as Map<String, String>;
      attrs['style'] = '--USER__textColor: #ebdbb2; ${attrs['style']}';
      ((tree['children']! as List).last as Map<String, Object>)['children'] = [
        ...(((tree['children']! as List).last as Map<String, Object>)['children']! as List),
        {
          'tag': 'div',
          'attrs': {'id': 'r2-decoration-0', 'style': 'background-color: rgba(250, 189, 47, 0.4) !important'},
          'children': [
            {'tag': 'span', 'attrs': {'id': 'r2-decoration-child', 'style': 'color: #000 !important'}, 'children': <Object>[]},
          ],
        },
      ];
      final dir = Directory.systemTemp.createTempSync('theme_dom');
      addTearDown(() => dir.deleteSync(recursive: true));
      final input = File('${dir.path}/input.json')
        ..writeAsStringSync(jsonEncode({'script': File('$helpers/thereaderTheme.js').absolute.path, 'tree': tree}));
      final run = Process.runSync('node', ['test/support/theme_dom_harness.cjs', input.path]);
      expect(run.exitCode, 0, reason: '${run.stderr}');
      final out = (jsonDecode(run.stdout as String) as Map).cast<String, Object>();

      expect(out['html'], '--USER__textColor: #ebdbb2; background-color: #fff');
      expect(out['body'], 'color: #001; background-color: #fffff0');
      expect(out['inline-important'], 'color: #003; background-color: #fff; text-shadow: 0 0 2px #fff');
      expect(out['art'], contains('color: #c00 !important'));
      expect(out['art-text'], 'fill: #fff !important; color: #fff !important');
      expect(out['formula-mi'], 'color: #060 !important');
      expect(out['r2-decoration-0'], contains('!important'));
      expect(out['r2-decoration-child'], contains('!important'));
      // Everything demotable went in the single pass; a rerun finds nothing.
      expect(out['__second'], 0);
    }, skip: _hasNode ? false : 'node is not installed');

    test('the Dart engine drops publisher colour sources but keeps code text', () {
      final html = DartReaderView.prepareHtml(fixture);
      final text = html.replaceAll(RegExp(r'<(svg|math)\b[\s\S]*?</\1>'), '');
      expect(html, isNot(contains('<style')));
      expect(text, isNot(contains('!important')));
      expect(text, isNot(contains(RegExp(r'<[A-Za-z][^>]*\sstyle\s*='))));
      // Artwork keeps its own colours.
      expect(html, contains('style="fill: #fff !important; color: #fff !important"'));
      expect(html, contains('<mi id="formula-mi" style="color: #060 !important">'));
      expect(html, isNot(contains('<font color')));
      expect(html, contains('plt.plot(x, color="red")  # style="kept as code"'));
      expect(html, contains('<a href="#fig">'));
      expect(html, contains('<img src="data:image/gif'));
    });

    test('the Dart engine paints every heading, caption and cell in ink', () {
      const prefs = ReaderPreferences();
      final colors = ThemePreset.gruvbox.colors;
      for (final tag in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'caption', 'th', 'td', 'pre', 'code']) {
        expect(DartReaderView.stylesFor(tag, prefs, colors)!['color'], colors.ink.toCssHex(), reason: tag);
      }
      expect(DartReaderView.stylesFor('td', prefs, colors)!['border-color'], colors.border.toCssHex());
      expect(DartReaderView.stylesFor('pre', prefs, colors)!['font-family'], 'monospace');
    });
  });

  testWidgets('the picker sets each name in its own face and applies immediately', (tester) async {
    // A phone-sized portrait viewport.
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final settings = SettingsRepository(MemoryKeyValueStore());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.build(AppColors.defaults),
      home: Scaffold(body: ReaderFontPicker(settings: settings)),
    ));

    for (final f in ReaderFonts.all) {
      final label = tester.widget<Text>(find.text(f.label));
      expect(label.style?.fontFamily, f.flutterFamily, reason: f.id);
    }
    expect(find.text('Recommended'), findsOneWidget);
    expect(find.text(ReaderFonts.systemSerif.description), findsOneWidget);

    await tester.tap(find.text(ReaderFonts.atkinson.label));
    await tester.pumpAndSettle();
    expect(settings.reader.font, ReaderFont.sans);
    expect(settings.reader.fontFamilyId, ReaderFonts.atkinson.id);
    expect(find.text(ReaderFonts.atkinson.description), findsOneWidget);
    final selected = find.ancestor(of: find.byIcon(Icons.check), matching: find.byType(Row));
    expect(find.descendant(of: selected.first, matching: find.text(ReaderFonts.atkinson.label)), findsOneWidget);
  });
}
