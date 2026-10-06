import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/tokens.dart';
import 'package:thereader/features/articles/article_media.dart';
import 'package:thereader/features/articles/svg_prepare.dart';
import 'package:xml/xml.dart';

import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/features/articles/article_blocks.dart';
import 'package:thereader/features/articles/article_style.dart';
import 'package:thereader_extract/thereader_extract.dart';

PreparedSvg prepare(String source) => prepareSvg(source, ink: Palette.fg, paper: Palette.bg)!;

/// [blocks] in an article scope at [width], with links reported to [onLink].
Widget blocksAt(double width, List<Block> blocks, {ValueChanged<String>? onLink}) => MaterialApp(
  theme: AppTheme.dark,
  home: Scaffold(
    body: ArticleScope(
      style: ArticleStyle.of(const ReaderPreferences(), AppColors.defaults),
      onLink: onLink ?? (_) {},
      onFootnote: (_) {},
      onFootnoteBack: () {},
      onImages: (_, _) {},
      footnoteKey: (_) => GlobalKey(),
      child: SingleChildScrollView(
        child: SizedBox(
          width: width,
          child: Column(children: [for (final b in blocks) BlockView(block: b)]),
        ),
      ),
    ),
  ),
);

XmlElement first(PreparedSvg svg, String name) =>
    XmlDocument.parse(svg.source).rootElement.descendantElements.firstWhere((e) => e.localName == name);

void main() {
  const styled = '''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
<style>
:root { color-scheme: dark light; --edge: canvastext; --accent: #52a8ff; }
text { fill: canvastext; font: 12px sans-serif; }
.box { stroke: var(--edge); fill: var(--missing, var(--accent)); }
g > rect#hero.box { stroke-width: 3 }
</style>
<g><rect id="hero" class="box" x="10" y="10" width="80" height="30"/></g>
<text x="50" y="55">Tokenizer</text>
<defs><linearGradient id="g"><stop stop-color="var(--accent)"/></linearGradient></defs>
</svg>''';

  test('stylesheet rules, var() and system colours become attributes', () {
    final svg = prepare(styled);
    expect(svg.onLight, isFalse);
    final rect = first(svg, 'rect');
    expect(rect.getAttribute('stroke'), '#ededed');
    expect(rect.getAttribute('fill'), '#52a8ff');
    expect(rect.getAttribute('stroke-width'), '3');
    final text = first(svg, 'text');
    expect(text.getAttribute('fill'), '#ededed');
    expect(text.getAttribute('font-size'), '12px');
    expect(first(svg, 'stop').getAttribute('stop-color'), '#52a8ff');
    expect(svg.source, isNot(contains('<style')));
    expect(svg.source, isNot(contains('var(')));
  });

  test('dark media rules apply; light ones do not', () {
    final svg = prepare('''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
<style>
rect { fill: white; }
@media (prefers-color-scheme: light) { rect { fill: black; } }
@media (prefers-color-scheme: dark) { rect { stroke: canvastext; } }
@media print { rect { fill: red; } }
</style>
<rect width="5" height="5"/>
</svg>''');
    expect(first(svg, 'rect').getAttribute('fill'), 'white');
    expect(first(svg, 'rect').getAttribute('stroke'), '#ededed');
  });

  test('inline style beats the stylesheet, which beats presentation attributes', () {
    final svg = prepare('''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
<style>.a { fill: #ff0000; stroke: #00ff00 }</style>
<rect class="a" fill="#0000ff" stroke="#0000ff" style="stroke: #ffff00" width="5" height="5"/>
</svg>''');
    expect(first(svg, 'rect').getAttribute('fill'), '#ff0000');
    expect(first(svg, 'rect').getAttribute('stroke'), '#ffff00');
  });

  test('black ink on a transparent canvas is drawn on a light panel', () {
    final svg = prepare('''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
<style>text { fill: canvastext }</style>
<path d="M0 0L10 10" stroke="black"/><text x="1" y="9">A</text>
</svg>''');
    expect(svg.onLight, isTrue);
    expect(svg.ink, Palette.bg);
    expect(first(svg, 'text').getAttribute('fill'), '#000000');

    // Unstyled text defaults to black too.
    expect(prepare('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>A</text></svg>').onLight, isTrue);
  });

  test('a diagram with its own background or light ink stays on the page', () {
    expect(
      prepare(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="100%" height="100%" fill="#fff"/><text>A</text></svg>',
      ).onLight,
      isFalse,
    );
    expect(
      prepare('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L9 9" fill="none" stroke="#f90"/></svg>').onLight,
      isFalse,
    );
  });

  test('unparseable or empty SVGs are rejected', () {
    expect(prepareSvg('<svg><g></svg', ink: Palette.fg, paper: Palette.bg), isNull);
    expect(prepareSvg('<html/>', ink: Palette.fg, paper: Palette.bg), isNull);
    expect(
      prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><path d="M0 0"/></defs></svg>', ink: Palette.fg, paper: Palette.bg),
      isNull,
    );
    expect(
      prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" fill="none"/></svg>', ink: Palette.fg, paper: Palette.bg),
      isNull,
    );
  });

  test('the WHATWG parsing-model diagram draws dark with readable ink', () {
    final svg = prepare(File('test/fixtures/parsing_model.svg').readAsStringSync());
    expect(svg.onLight, isFalse);
    final doc = XmlDocument.parse(svg.source);
    final texts = doc.rootElement.descendantElements.where((e) => e.localName == 'text');
    expect(texts, isNotEmpty);
    expect(texts.every((t) => t.getAttribute('fill') == '#ededed'), isTrue);
    final box = doc.rootElement.descendantElements.firstWhere((e) => e.getAttribute('class') == 'box');
    expect(box.getAttribute('stroke'), '#ededed');
    expect(box.getAttribute('fill'), 'url(#grad)');
    final stops = doc.rootElement.descendantElements.where((e) => e.localName == 'stop').map((e) => e.getAttribute('stop-color'));
    expect(stops, ['#338833', '#000000']);
  });

  testWidgets('flutter_svg draws the prepared diagram with light ink on black', (tester) async {
    Future<(int, int)> count(String source) async {
      final info = await vg.loadPicture(SvgStringLoader(source), null);
      final image = await info.picture.toImage(345, 535);
      final bytes = (await image.toByteData())!;
      var light = 0, opaque = 0;
      for (var i = 0; i < bytes.lengthInBytes; i += 4) {
        if (bytes.getUint8(i + 3) > 0) opaque++;
        if (bytes.getUint8(i) > 200 && bytes.getUint8(i + 1) > 200 && bytes.getUint8(i + 2) > 200) light++;
      }
      info.picture.dispose();
      image.dispose();
      return (light, opaque);
    }

    final raw = File('test/fixtures/parsing_model.svg').readAsStringSync();
    final (rawLight, _) = (await tester.runAsync(() => count(raw)))!;
    final (light, opaque) = (await tester.runAsync(() => count(prepare(raw).source)))!;
    // Unprepared, the text and outlines come out black: nothing light at all.
    expect(rawLight, 0);
    expect(light, greaterThan(1000));
    expect(opaque, greaterThan(light));
  });

  group('figures', () {
    setUp(ArticleSvg.clearCache);

    String data(String svg) => 'data:image/svg+xml,${Uri.encodeComponent(svg)}';

    testWidgets('a stylesheet-driven SVG draws instead of an empty card', (tester) async {
      await tester.pumpWidget(
        blocksAt(360, [
          FigureBlock(
            images: [ArticleImage(src: data(styled), alt: 'Parsing model', width: 100, height: 60)],
          ),
        ]),
      );
      await tester.pump();
      expect(find.byType(SvgPicture), findsOneWidget);
      expect(find.byType(SvgUnavailable), findsNothing);
      expect(find.byKey(const ValueKey('svg-light-panel')), findsNothing);
    });

    testWidgets('dark ink on transparency gets a light panel', (tester) async {
      const ink = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10" stroke="#000"/></svg>';
      await tester.pumpWidget(
        blocksAt(360, [
          FigureBlock(
            images: [ArticleImage(src: data(ink), alt: '', width: 10, height: 10)],
          ),
        ]),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('svg-light-panel')), findsOneWidget);
    });

    testWidgets('an unparseable SVG falls back to its alt text and an open action', (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(
        blocksAt(360, [
          FigureBlock(
            images: [ArticleImage(src: 'https://example.test/broken.svg', alt: 'Parsing model overview', width: 345, height: 535)],
          ),
        ], onLink: opened.add),
      );
      await tester.pump();
      // No network in tests: the fetch fails, like a parse error would.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.byType(SvgUnavailable), findsOneWidget);
      expect(find.text('Parsing model overview'), findsOneWidget);
      await tester.tap(find.text('Open image'));
      expect(opened, ['https://example.test/broken.svg']);
    });

    testWidgets('a data: SVG that does not parse shows the card without an open action', (tester) async {
      await tester.pumpWidget(
        blocksAt(360, [
          FigureBlock(
            images: [ArticleImage(src: data('<svg><g></svg'), alt: 'Diagram', width: 100, height: 60)],
          ),
        ]),
      );
      await tester.pump();
      expect(find.byType(SvgUnavailable), findsOneWidget);
      expect(find.text('Diagram'), findsOneWidget);
      expect(find.text('Open image'), findsNothing);
    });
  });
}
