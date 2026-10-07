import 'dart:typed_data';

import 'package:archive/archive.dart' show getCrc32;
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/reader/dart_engine/epub_blocks.dart';
import 'package:thereader/reader/dart_engine/epub_chapter.dart';
import 'package:thereader/reader/dart_engine/epub_tex.dart';

// Chapters, formulas and images are untrusted. Each case here used to cost
// time quadratic in its size (80 KB froze the reader for up to 30 s) or
// memory far beyond it.

void main() {
  group('chapter preparation stays linear', () {
    const size = 200 << 10;
    final cases = {
      'unclosed \\[': '<p>${r'\[ ' * (size ~/ 3)}</p>',
      'unclosed \\(': '<p>${r'\( ' * (size ~/ 3)}</p>',
      'unterminated tags': '<p>x</p>${'<img ' * (size ~/ 5)}',
      'openers inside one tag':
          '<p>x</p><img ${'<img data-tr-em-h="1" <span ' * (size ~/ 30)}>',
      'unclosed styles': '<p>x</p>${'<style>' * (size ~/ 7)}',
      'unclosed scripts':
          '<p>x</p>${'<script type="math/tex">' * (size ~/ 24)}',
      'unclosed artwork': '<p>x</p>${'<svg><math>' * (size ~/ 11)}',
      'many bodies': '${'<body>' * (size ~/ 6)}x',
      'one long PDF paragraph':
          '<meta name="generator" content="pdftohtml"/><body>'
          '${'<p>the quick brown fox jumps over the lazy dog and,</p>\n' * (size ~/ 55)}</body>',
      'unclosed MathML attributes': '<p>x</p>${'<span data-mathml="<math> ' * (size ~/ 26)}',
      'MathML attributes and scripts':
          '<p>${'<span data-mathml="&lt;math&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;">x</span>' * (size ~/ 80)}'
          '${'<script type="math/mml"><math><mi>y</mi></math></script>' * (size ~/ 60)}</p>',
      'page anchors in one paragraph':
          '<meta name="generator" content="pdftohtml"/><body><p>'
          '${'<a id="p1"></a>12 ' * (size ~/ 20)}</p></body>',
    };
    for (final MapEntry(key: name, value: html) in cases.entries) {
      test(name, () {
        final watch = Stopwatch()..start();
        EpubChapter.prepare(html);
        expect(watch.elapsed, lessThan(const Duration(seconds: 3)));
      });
    }
  });

  group('chapter preparation keeps its meaning', () {
    test('delimited TeX in running text', () {
      final out = EpubChapter.prepare(
        r'<p>a \[x\] b \(y\) c $$z$$ d \[ open</p>',
      );
      expect(out, contains(r'<span class="math display">\[x\]</span>'));
      expect(out, contains(r'<span class="math inline">\(y\)</span>'));
      expect(out, contains(r'<span class="math display">$$z$$</span>'));
      expect(out, contains(r'd \[ open'));
    });

    test('an unclosed style or script hides the rest, as a browser would', () {
      expect(
        EpubChapter.prepare('<p>kept</p><style>p{color:red}<p>gone</p>'),
        '<p>kept</p>',
      );
      expect(
        EpubChapter.prepare('<p>kept</p><script>x<p>gone</p>'),
        '<p>kept</p>',
      );
      // An opener quoted inside another element's text is not an opener.
      expect(
        EpubChapter.prepare("<script>var s = '<style>';</script><p>kept</p>"),
        '<p>kept</p>',
      );
      // Custom elements that merely start with the name are content.
      expect(
        EpubChapter.prepare('<styled-box>kept</styled-box>'),
        '<styled-box>kept</styled-box>',
      );
    });

    test('MathJax sources still become math spans', () {
      expect(
        EpubChapter.prepare(
          '<p><script type="math/tex; mode=display">a&lt;b</script></p>',
        ),
        contains(
          '<span class="math display" data-tr-tex="script">a&lt;b</span>',
        ),
      );
      // A script whose start tag never closes is dropped, not misread.
      expect(
        EpubChapter.prepare(
          '<p>x</p><script type="math/tex" </script><p>y</p>',
        ),
        '<p>x</p><p>y</p>',
      );
    });

    test('colours are still stripped before and after artwork', () {
      final out = EpubChapter.prepare(
        '<p style="color:red">a</p><svg><rect style="fill:red"/></svg><p color="blue">b</p>',
      );
      expect(out, '<p>a</p><svg><rect style="fill:red"/></svg><p>b</p>');
    });
  });

  group('TeX', () {
    test('formulas that define macros are left to the publisher', () {
      expect(EpubTex.tryParse(r'x^2'), isNotNull);
      for (final tex in [
        r'\newcommand{\a}{xxxx}\a\a',
        r'\renewcommand{\b}{x}\b',
        r'\def\a{x}\a',
        r'\gdef\a{x}\a',
        r'\let\a\b',
      ]) {
        expect(EpubTex.tryParse(tex), isNull, reason: tex);
      }
      expect(
        EpubTex.tryParse(r'\default'),
        isNull,
        reason: 'unknown, but not a definition',
      );
      expect(EpubTex.tryParse(r'\delta + \left( x \right)'), isNotNull);
    });

    test('very long formulas are left to the publisher', () {
      expect(EpubTex.tryParse('x+' * (EpubTex.maxLength ~/ 2 + 1)), isNull);
      expect(EpubTex.tryParse('x+' * 1000 + 'x'), isNotNull);
    });
  });

  test(
    'images declaring huge frames are not decoded for ink sampling',
    () async {
      expect(await InkAnalysis.sample(_png(100000, 100000)), isNull);
    },
  );
}

/// A PNG that declares [width]×[height] and carries no pixel data.
Uint8List _png(int width, int height) {
  final out = BytesBuilder()
    ..add([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  void chunk(String type, List<int> data) {
    final body = [...type.codeUnits, ...data];
    out
      ..add(_be32(data.length))
      ..add(body)
      ..add(_be32(getCrc32(body)));
  }

  chunk('IHDR', [..._be32(width), ..._be32(height), 8, 6, 0, 0, 0]);
  chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  chunk('IEND', []);
  return out.toBytes();
}

List<int> _be32(int v) => [
  v >> 24 & 0xff,
  v >> 16 & 0xff,
  v >> 8 & 0xff,
  v & 0xff,
];
