import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/dart_engine/epub_blocks.dart';
import 'package:thereader/reader/dart_engine/epub_package.dart';

/// Technical content through the real Dart engine view: typeset math, code
/// panels, ink-adaptive images, wide tables. The book is generated here.

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

/// A 60×20 PNG: a dark stroke on transparency, or a filled opaque photo.
Future<Uint8List> _png({required bool transparent}) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  if (!transparent) canvas.drawRect(const Rect.fromLTWH(0, 0, 60, 20), Paint()..color = const Color(0xff6a8caf));
  canvas.drawRect(const Rect.fromLTWH(10, 8, 40, 4), Paint()..color = const Color(0xff111111));
  final image = await recorder.endRecording().toImage(60, 20);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

const _chapter = '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sample</title></head><body>
<p>Inline <math><msup><mi>x</mi><mn>2</mn></msup></math> and a pandoc <span class="math inline">\\(a_1 + b\\)</span> sum.</p>
<math display="block"><mfrac><mn>1</mn><mi>n</mi></mfrac></math>
<p>Image formula <span class="inline_math"><img src="eq.png" alt="\\vec{v} \\in V" style="height:1.1em; vertical-align:-0.1em;"/></span>
and one only the book understands <span class="inline_math"><img src="eq.png" alt="\\bookOnlyMacro{v}" style="height:1.1em"/></span>.</p>
<div class="figure"><img src="diagram.png" alt="A line diagram"/></div>
<div class="figure"><img src="photo.png" alt="A photograph"/></div>
<pre class="language-python"><code>def long_function_name(argument_one, argument_two, argument_three, argument_four):
    return argument_one</code></pre>
<p>Call <code>main()</code> to start.</p>
<table><tr><td>alpha_beta_gamma_delta_epsilon</td><td>zeta_eta_theta_iota_kappa_lambda</td><td>mu_nu_xi_omicron_pi_rho_sigma</td></tr></table>
</body></html>''';

Future<EpubPackage> _book() async {
  final archive = Archive()
    ..add(ArchiveFile.string('mimetype', 'application/epub+zip'))
    ..add(ArchiveFile.string('META-INF/container.xml', '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'''))
    ..add(ArchiveFile.string('OEBPS/content.opf', '''<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Sample</dc:title></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="eq" href="eq.png" media-type="image/png"/><item id="d" href="diagram.png" media-type="image/png"/>
<item id="p" href="photo.png" media-type="image/png"/></manifest>
<spine><itemref idref="c1"/></spine></package>'''))
    ..add(ArchiveFile.string('OEBPS/c1.xhtml', _chapter));
  for (final (name, transparent) in [('eq.png', true), ('diagram.png', true), ('photo.png', false)]) {
    final png = await _png(transparent: transparent);
    archive.add(ArchiveFile('OEBPS/$name', png.length, png));
  }
  return EpubPackage.open(_BytesFile(Uint8List.fromList(ZipEncoder().encode(archive))));
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  testWidgets('math, code, images and tables render natively without overflow', (tester) async {
    tester.view.physicalSize = const Size(390, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final package = (await tester.runAsync(_book))!;
    final controller = DartReaderController(package: package, prefs: const ReaderPreferences());
    addTearDown(controller.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: Scaffold(body: DartReaderView(controller: controller))));
    await _settle(tester);
    expect(tester.takeException(), isNull);

    // MathML inline + display, the pandoc span and the TeX-alt image.
    expect(find.byType(Math), findsNWidgets(4));
    final colors = AppColors.defaults;
    final math = tester.widgetList<Math>(find.byType(Math));
    expect(math.map((m) => m.mathStyle), containsAll([MathStyle.text, MathStyle.display]));
    expect(math.every((m) => m.textStyle?.color == colors.ink), isTrue);

    // The unknown macro falls back to the book's image, inverted to read on black;
    // so does the transparent diagram. The photograph is untouched.
    final adaptive = tester.widgetList<InkAdaptiveImage>(find.byType(InkAdaptiveImage)).map((w) => w.path).toList();
    expect(adaptive, containsAll(['OEBPS/eq.png', 'OEBPS/diagram.png', 'OEBPS/photo.png']));
    Finder filtered(String path) => find.descendant(
          of: find.byWidgetPredicate((w) => w is InkAdaptiveImage && w.path == path),
          matching: find.byType(ColorFiltered),
        );
    expect(filtered('OEBPS/eq.png'), findsOneWidget);
    expect(filtered('OEBPS/diagram.png'), findsOneWidget);
    expect(filtered('OEBPS/photo.png'), findsNothing);

    // Code: a highlighted panel that scrolls sideways instead of wrapping.
    final code = find.byType(EpubCodeBlock);
    expect(code, findsOneWidget);
    expect(tester.widget<EpubCodeBlock>(code).language, 'python');
    final codeText = tester.widget<Text>(find.descendant(of: code, matching: find.byType(Text)));
    expect(codeText.softWrap, isFalse);
    final spans = <TextSpan>[];
    codeText.textSpan!.visitChildren((s) {
      if (s is TextSpan && s.style?.color != null) spans.add(s);
      return true;
    });
    expect(spans.any((s) => s.style!.color == colors.purple && s.text == 'def'), isTrue);
    final codeScroll = find.descendant(of: code, matching: find.byType(SingleChildScrollView));
    expect(tester.widget<SingleChildScrollView>(codeScroll).scrollDirection, Axis.horizontal);
    final decoration = tester.widget<DecoratedBox>(find.descendant(of: code, matching: find.byType(DecoratedBox)).first);
    expect((decoration.decoration as BoxDecoration).color, colors.panel);
    expect(tester.getSize(code).width, lessThanOrEqualTo(390));

    // The wide table scrolls inside the column.
    final scrolls = tester.widgetList<SingleChildScrollView>(find.byType(SingleChildScrollView));
    expect(scrolls.where((s) => s.scrollDirection == Axis.horizontal).length, greaterThanOrEqualTo(3));
    expect(tester.takeException(), isNull);
  });

  test('inline code gets a subtle panel, code inside pre does not', () {
    final colors = AppColors.defaults;
    const prefs = ReaderPreferences();
    expect(DartReaderView.stylesFor('code', prefs, colors)!['background-color'], colors.element.toCssHex());
    expect(DartReaderView.stylesFor('code', prefs, colors, inPre: true)!['background-color'], isNull);
    expect(DartReaderView.stylesFor('pre', prefs, colors)!['white-space'], 'pre');
  });

  test('declared code languages are read from the usual places', () {
    String? lang(String markup) => EpubContentBuilder.codeLanguage(html.parse(markup).querySelector('pre')!);
    expect(lang('<pre class="language-rust">x</pre>'), 'rust');
    expect(lang('<pre><code class="lang-js">x</code></pre>'), 'js');
    expect(lang('<pre class="sourceCode python"><code class="sourceCode python">x</code></pre>'), 'python');
    expect(lang('<pre class="brush: java;">x</pre>'), 'java');
    expect(lang('<pre data-code-language="go">x</pre>'), 'go');
    expect(lang('<pre class="code-area">x</pre>'), isNull);
    expect(lang('<pre class="c">x</pre>'), isNull);
  });

  group('ink analysis', () {
    Uint8List pixels(List<(int, int, int, int)> colors, int repeat) =>
        Uint8List.fromList([for (var i = 0; i < repeat; i++) for (final c in colors) ...[c.$1, c.$2, c.$3, c.$4]]);

    test('dark ink on transparency is inverted', () {
      expect(InkAnalysis.isDarkInk(pixels([(0, 0, 0, 0), (0, 0, 0, 0), (20, 20, 20, 255)], 50)), isTrue);
    });

    test('opaque images, light ink and empty images are left alone', () {
      expect(InkAnalysis.isDarkInk(pixels([(30, 30, 30, 255)], 100)), isFalse, reason: 'opaque dark photo');
      expect(InkAnalysis.isDarkInk(pixels([(255, 255, 255, 255), (0, 0, 0, 255)], 50)), isFalse, reason: 'opaque');
      expect(InkAnalysis.isDarkInk(pixels([(0, 0, 0, 0), (240, 240, 240, 255)], 50)), isFalse, reason: 'light ink');
      expect(InkAnalysis.isDarkInk(pixels([(0, 0, 0, 0)], 100)), isFalse, reason: 'empty');
    });

    test('the inversion lands black ink on the theme ink', () {
      final ink = AppColors.defaults.ink;
      final m = inkInversionMatrix(ink);
      int channel(int row) => (m[row * 5 + 4]).round();
      expect([channel(0), channel(1), channel(2)], [(ink.r * 255).round(), (ink.g * 255).round(), (ink.b * 255).round()]);
    });
  });
}
