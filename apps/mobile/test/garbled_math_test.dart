import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:thereader/reader/dart_engine/epub_chapter.dart';
import 'package:thereader/reader/dart_engine/epub_tex.dart';
import 'package:thereader/reader/dart_engine/garbled_math.dart';
import 'package:thereader/reader/dart_engine/garbled_table.dart';

/// Pieces from a string where ‹…› marks italic text.
List<GarbledPiece> _pieces(String line) => [
      for (final m in RegExp(r'‹([^›]*)›|[^‹]+').allMatches(line))
        m[1] != null ? GarbledPiece(m[1]!, italic: true) : GarbledPiece(m[0]!),
    ];

/// The line with each formula replaced by ⟦its plain reading⟧.
String _read(String line) {
  final pieces = _pieces(line);
  final text = pieces.map((p) => p.text).join();
  final out = StringBuffer();
  var at = 0;
  for (final run in GarbledMath.decodeLine(pieces)) {
    out
      ..write(text.substring(at, run.start))
      ..write('⟦${run.plain}⟧');
    at = run.end;
  }
  return '$out${text.substring(at)}';
}

const _generator = '<meta name="generator" content="pdftohtml 0.36"/>';

String _chapter(String body) => '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
    '<head><title>t</title>$_generator</head><body>$body</body></html>';

const _garbled = '''
<p>Suppose x; y 2 R and x C y D 1.</p>
<p>Then S D fx 2 R W x &gt; 0g is not empty.</p>
<p>hx; <i>y</i> i D 0 for all <i>y </i> 2 V.</p>
<p>x C y D y C x</p>
<p>Vitamin C is good for you, and Plan D is not; mix 2 cups.</p>
<p>Ask René and Jørgen.</p>
<p>for all ˛; ˇ 2 C we have ˛ C Ď ˇ C ˛.</p>
<p>kxk2 D hx; xi and u1; : : : ; um 2 U.</p>
''';

void main() {
  // Run from apps/mobile: the web side owns the table and the shared cases.
  final web = Directory('../web');

  test('the glyph table mirrors the web one', () {
    final table = jsonDecode(File('${web.path}/src/reader/enhance/garbled-table.json').readAsStringSync()) as Map<String, dynamic>;
    expect(
      {for (final e in GarbledTable.fused.entries) e.key: [e.value.$1, e.value.$2]},
      table['fused'],
    );
    expect({for (final e in GarbledTable.symbols.entries) e.key: [e.value.$1, e.value.$2, e.value.$3]}, table['symbols']);
    expect({for (final e in GarbledTable.letterOps.entries) e.key: [e.value.$1, e.value.$2, e.value.$3]}, table['letterOps']);
    expect(GarbledTable.fields.toList(), table['fields']);
    expect(GarbledTable.calligraphic.toList(), table['calligraphic']);
    expect(GarbledTable.functions.toList(), table['functions']);
    expect(GarbledTable.words, table['words']);
    expect(GarbledTable.commonOverride, table['commonOverride']);
  });

  group('lines read like the web decoder', () {
    final cases = (jsonDecode(File('${web.path}/fixtures/garbled-lines.json').readAsStringSync())['cases'] as List).cast<List>();
    for (final c in cases) {
      test(c[0] as String, () => expect(_read(c[0] as String), c[1]));
    }
  });

  test('every TeX symbol in the table parses', () {
    for (final (_, tex, _) in [...GarbledTable.symbols.values, ...GarbledTable.letterOps.values]) {
      expect(EpubTex.tryParse('a $tex b'), isNotNull, reason: tex);
    }
  });

  test('hostile lines are linear and never throw', () {
    for (final unit in ['W ', 'k ', 'f', 'h ', '.', '2 ', 'C ', 'ˇ', 'D D ', 'kx', ': ']) {
      final line = (unit * (3990 ~/ unit.length + 1)).substring(0, 3990);
      final watch = Stopwatch()..start();
      GarbledMath.decodeLine([GarbledPiece(line)]);
      expect(watch.elapsedMilliseconds, lessThan(500), reason: unit);
    }
    expect(GarbledMath.decodeLine([GarbledPiece('x D y ' * 2000)]), isEmpty);
  });

  group('chapters', () {
    test('gated on the garble signature', () {
      String text(String body) => html.parse(body).body!.text;
      expect(GarbledMath.isGarbled(text(_garbled)), isTrue);
      expect(GarbledMath.isGarbled(text('<p>Suppose x, y ∈ ℝ and x + y = 1 and ⟨x, y⟩ = 0 with x ≤ y.</p>' * 6)), isFalse);
      expect(GarbledMath.isGarbled(text('<p>Vitamin C and Plan D, 2 cups, René and Jørgen walked to the river.</p>' * 20)), isFalse);
    });

    test('formulas become math spans around their original text', () {
      final out = EpubChapter.prepare(_chapter(_garbled));
      final body = html.parse(out).body!;
      final spans = body.querySelectorAll('span.math');
      // Punctuation touching a formula goes with it, so no line starts with it.
      expect(spans.map((s) => s.attributes[GarbledMath.texAttr]).toList(), [
        r'x , y \in \mathbf{R}',
        r'x + y = 1\text{.}',
        r'S = \{ x \in \mathbf{R} : x > 0 \}',
        r'\langle x , y \rangle = 0',
        r'y \in V\text{.}',
        r'x + y = y + x',
        r'\alpha , \beta \in \mathbf{C}',
        r'\alpha + \beta = \beta + \alpha\text{.}',
        r'\| x \|^{2} = \langle x , x \rangle',
        r'u_{1} , \ldots , u_{m} \in U\text{.}',
      ]);
      expect(spans.where((s) => s.classes.contains('display')).length, 1);
      for (final span in spans) {
        expect(EpubTex.tryParse(EpubTex.normalize(span.attributes[GarbledMath.texAttr]!)), isNotNull);
      }
      // The original text is kept inside, in order: the builder falls back to it.
      expect(body.text.replaceAll(RegExp(r'\s+'), ' '), contains('hx; y i D 0 for all y 2 V.'));
      expect(body.innerHtml, contains('Vitamin C is good for you, and Plan D is not; mix 2 cups.'));
    });

    test('a converted prose book is untouched', () {
      final body = '<p>Vitamin C and Plan D, 2 cups; René and Jørgen walked to the river C D.</p>' * 20;
      expect(EpubChapter.prepare(_chapter(body)), isNot(contains('span class="math')));
    });
  });

  // The real book this rule was written for; skipped without the private copy.
  final book = File(Platform.environment['GARBLED_EPUB'] ?? '/tmp/ladr/books/ladr3e-v2.epub');
  test('real garbled book: formulas parse', () {
    final zip = ZipDecoder().decodeBytes(book.readAsBytesSync());
    var formulas = 0;
    var failed = 0;
    for (final file in zip.files.where((f) => f.isFile && RegExp(r'\.x?html?$').hasMatch(f.name))) {
      final body = html.parse(EpubChapter.prepare(utf8.decode(file.content as List<int>))).body!;
      for (final span in body.querySelectorAll('span.math[${GarbledMath.texAttr}]')) {
        formulas++;
        if (EpubTex.tryParse(EpubTex.normalize(span.attributes[GarbledMath.texAttr]!)) == null) failed++;
      }
    }
    expect(formulas, greaterThan(5000));
    expect(failed, 0);
  }, skip: book.existsSync() ? false : 'no local copy');
}
