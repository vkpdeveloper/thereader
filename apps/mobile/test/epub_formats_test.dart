import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/dart_engine/epub_blocks.dart';
import 'package:thereader/reader/dart_engine/epub_chapter.dart';
import 'package:thereader/reader/dart_engine/epub_package.dart';
import 'package:thereader/reader/dart_engine/epub_svg.dart';
import 'package:thereader/reader/dart_engine/epub_tex.dart';

/// Maths as other toolchains ship it (KaTeX, MathJax, attributes, SVG,
/// black-on-white images, MathML 2), through the Dart engine. Chapters come
/// from the committed enhancer sampler (apps/web/fixtures/enhance-sampler.epub).

class _BytesFile implements BookFile {
  _BytesFile(this.bytes);
  final Uint8List bytes;
  @override
  int get length => bytes.length;
  @override
  String? get path => null;
  @override
  Future<Uint8List> readAll() async => bytes;
  @override
  Future<Uint8List> readRange(int start, int end) async => bytes.sublist(start, end);
  @override
  Future<void> close() async {}
}

final _sampler = File('../web/fixtures/enhance-sampler.epub').readAsBytesSync();

Future<void> _show(WidgetTester tester, String id) async {
  tester.view.physicalSize = const Size(430, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final package = (await tester.runAsync(() => EpubPackage.open(_BytesFile(_sampler))))!;
  final href = package.spine.firstWhere((s) => s.href.split('/').last == '$id.xhtml').href;
  final controller = DartReaderController(package: package, prefs: const ReaderPreferences(), initial: ReadingLocator(href: href, progression: 0));
  addTearDown(controller.dispose);
  await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: Scaffold(body: DartReaderView(controller: controller))));
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(tester.takeException(), isNull);
}

/// Every run of text the HTML widget laid out, joined.
String _text(WidgetTester tester) =>
    tester.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).join('\n');

void main() {
  group('rendered maths shows its MathML or TeX, once', () {
    testWidgets('KaTeX', (tester) async {
      await _show(tester, 'katex');
      expect(find.byType(Math), findsNWidgets(2));
      // KaTeX's HTML half is not laid out as text.
      expect(_text(tester), isNot(contains('k=1')));
    });

    testWidgets('MathJax 3 CHTML and SVG', (tester) async {
      await _show(tester, 'mathjax3');
      expect(find.byType(Math), findsNWidgets(2));
      await _show(tester, 'mathjax3svg');
      expect(find.byType(Math), findsNWidgets(2));
      expect(find.byType(SvgPicture), findsNothing);
    });

    testWidgets('MathJax 2 frames, with and without their scripts', (tester) async {
      await _show(tester, 'mathjax2');
      expect(find.byType(Math), findsNWidgets(3));
      expect(_text(tester), isNot(contains('⟨v,v⟩')));
    });

    testWidgets('formulas in attributes and math/mml scripts', (tester) async {
      await _show(tester, 'attrs');
      // data-tex, data-latex, data-equation, data-mathml, the webtex image, the script.
      expect(find.byType(Math), findsNWidgets(6));
      expect(_text(tester), contains('(3.1)'));
    });

    testWidgets('MathML 2 and prefixed MathML', (tester) async {
      await _show(tester, 'mathml2');
      expect(find.byType(Math), findsNWidgets(5));
    });
  });

  testWidgets('SVG formulas, files and objects draw; artwork keeps its paint', (tester) async {
    await _show(tester, 'svg');
    final pictures = tester.widgetList<SvgPicture>(find.byType(SvgPicture)).toList();
    // Two inline formulas, the image, the object and the illustration.
    expect(pictures, hasLength(5));
    expect(_text(tester), isNot(contains('the length of (x, y)')));
  });

  testWidgets('black-on-white equation images invert; a colour chart does not', (tester) async {
    await _show(tester, 'paper');
    Finder filtered(String name) => find.descendant(
          of: find.byWidgetPredicate((w) => w is InkAdaptiveImage && w.path.endsWith(name)),
          matching: find.byType(ColorFiltered),
        );
    expect(filtered('eq-white.png'), findsOneWidget);
    expect(filtered('eq-white.gif'), findsOneWidget);
    expect(filtered('chart.png'), findsNothing);
    // "equation" labels the image; it is not TeX.
    expect(find.byType(Math), findsNothing);
  });

  group('preparation', () {
    test('MathML strings travel URI-encoded, math/mml scripts included', () {
      final out = EpubChapter.prepare('<html><body><p><span data-mathml="&lt;math&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;">x</span></p>'
          '<script type="math/mml; mode=display"><![CDATA[<math><mi>y</mi></math>]]></script></body></html>');
      expect(out, contains('data-tr-mml="${Uri.encodeComponent('<math><mi>x</mi></math>')}"'));
      expect(out, contains('class="math display" data-tr-tex="script" data-tr-mml="${Uri.encodeComponent('<math><mi>y</mi></math>')}"'));
      expect(out, isNot(contains('<mi>')));
    });

    test('a MathJax 2 display wrapper hides with its frame when the script source is kept', () {
      final out = EpubChapter.prepare('<html><body><div><span class="MathJax_Preview"></span><span class="mjx-chtml MJXc-display">'
          '<span id="MathJax-Element-1-Frame" class="mjx-chtml MathJax_CHTML">v</span></span>'
          '<script type="math/tex; mode=display">v</script></div></body></html>');
      expect(RegExp('MJXc-display" ${EpubMarks.hidden}').hasMatch(out), isTrue);
    });

    test('objects keep their em size', () {
      final out = EpubChapter.prepare('<html><body><p><object data="a.svg" style="height:1.4em; vertical-align:-0.4em">f</object></p></body></html>');
      expect(out, contains('${EpubMarks.emHeight}="1.4"'));
    });

    test('image labels are not TeX', () {
      for (final alt in ['equation', 'Equation 3.2', 'formula', 'number_line']) {
        expect(EpubTex.looksLikeTex(alt, mathContext: true), isFalse, reason: alt);
      }
      for (final alt in ['x_1', 'sin x + cos y', 'T(x,y) = (x, y, x+y)', r'\frac{a}{b}']) {
        expect(EpubTex.looksLikeTex(alt, mathContext: true), isTrue, reason: alt);
      }
    });
  });

  group('SVG ink', () {
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    test('dark paint becomes currentColor; unpainted shapes follow it', () {
      final out = EpubSvg.inked(EpubSvg.parse('<svg $ns><path fill="#000"/><path style="stroke:black;stroke-width:2"/><path fill="none"/></svg>')!)!;
      expect(out, contains('fill="currentColor"'));
      expect(out, contains('stroke:currentColor'));
      expect(out, contains('fill="none"'));
      expect(EpubSvg.inked(EpubSvg.parse('<svg $ns><path/></svg>')!), contains('<svg $ns fill="currentColor">'));
    });

    test('colour, gradients, images, backgrounds and class styles are artwork', () {
      for (final inner in [
        '<circle fill="#f2a541"/>',
        '<linearGradient id="g"/><rect fill="url(#g)"/>',
        '<image href="a.png"/>',
        '<rect fill="#fff"/><path fill="#000"/>',
        '<style>.a{fill:#000}</style><path class="a"/>',
      ]) {
        expect(EpubSvg.inked(EpubSvg.parse('<svg $ns>$inner</svg>')!), isNull, reason: inner);
      }
      expect(EpubSvg.parse('<svg $ns>'), isNull);
      expect(EpubSvg.parse('<html/>'), isNull);
    });

    test('lengths in em, ex, pt and px', () {
      expect(EpubSvg.length('2ex', 20), closeTo(18, 0.01));
      expect(EpubSvg.length('1.5em', 20), 30);
      expect(EpubSvg.length('40', 20), 40);
      expect(EpubSvg.length('100%', 20), isNull);
    });
  });

  group('black on white', () {
    /// A 20×20 sample with a white border around [ink].
    Uint8List framed((int, int, int, int) Function(int i) ink) => Uint8List.fromList([
          for (var i = 0; i < 400; i++)
            ...(() {
              final x = i % 20, y = i ~/ 20;
              final c = x == 0 || y == 0 || x == 19 || y == 19 ? (255, 255, 255, 255) : ink(i);
              return [c.$1, c.$2, c.$3, c.$4];
            })(),
        ]);

    test('grey ink on white is paper; colour, photos and dark grounds are not', () {
      expect(InkAnalysis.isInkOnPaper(framed((i) => i % 7 == 0 ? (15, 15, 15, 255) : (255, 255, 255, 255)), 20), isTrue);
      expect(InkAnalysis.isInkOnPaper(framed((i) => i % 7 == 0 ? (200, 30, 30, 255) : (255, 255, 255, 255)), 20), isFalse);
      expect(InkAnalysis.isInkOnPaper(framed((i) => i % 3 == 0 ? ((i * 37) % 200, (i * 37) % 200, (i * 37) % 200, 255) : (250, 250, 250, 255)), 20), isFalse);
      expect(InkAnalysis.isInkOnPaper(framed((i) => i % 7 == 0 ? (255, 255, 255, 255) : (0, 0, 0, 255)), 20), isFalse);
      expect(InkAnalysis.isInkOnPaper(framed((i) => i % 7 == 0 ? (15, 15, 15, 255) : (0, 0, 0, 0)), 20), isFalse);
    });

    test('JPEG equation exports are inspected too', () {
      expect(InkAdaptiveImage.canHaveAlpha('Images/eq1.jpg'), isTrue);
      expect(InkAdaptiveImage.canHaveAlpha('Images/eq1.svg'), isFalse);
    });
  });
}
