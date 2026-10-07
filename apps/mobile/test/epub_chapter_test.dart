import 'package:flutter_test/flutter_test.dart';
import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/dart_engine/epub_chapter.dart';

/// The Dart engine's chapter preparation: math sources kept for the
/// builders, publisher-hidden content kept hidden, and pdftohtml repairs.
/// Snippets are original.

String _doc(String body, {String head = ''}) =>
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head>$head</head><body>$body</body></html>';

dom.Element _prepared(String body, {String head = ''}) =>
    html.parse('<body>${DartReaderView.prepareHtml(_doc(body, head: head))}</body>').body!;

bool _hidden(dom.Element e) => e.attributes.containsKey(EpubMarks.hidden);

const _pdfHead = '<meta name="generator" content="pdftohtml 0.36"/>';

void main() {
  group('math sources', () {
    test('MathJax scripts become math spans holding the same TeX', () {
      final body = _prepared('<p>Area <span class="MathJax_Preview">πr²</span>'
          '<script type="math/tex">\\pi r^2 &lt; 4</script> and</p>'
          '<script type="math/tex; mode=display">\\int_0^1 x\\,dx</script><script>alert(1)</script>');
      final spans = body.querySelectorAll('span.math');
      expect(spans.map((s) => s.classes.contains('display')), [false, true]);
      expect(spans.first.text, r'\pi r^2 < 4');
      expect(spans.last.text, r'\int_0^1 x\,dx');
      expect(_hidden(body.querySelector('.MathJax_Preview')!), isTrue);
      expect(body.querySelector('script'), isNull);
    });

    test(r'$$…$$ in running text is wrapped without losing a character', () {
      final body = _prepared(r'<p>So $$a^2+b^2=c^2$$ holds, unlike <code>echo $$</code>.</p>');
      final span = body.querySelector('span.math.display')!;
      expect(span.text, r'$$a^2+b^2=c^2$$');
      expect(body.text, r'So $$a^2+b^2=c^2$$ holds, unlike echo $$.');
      expect(body.querySelectorAll('span.math'), hasLength(1));
    });

    test(r'\(…\) and \[…\] in running text become math spans', () {
      final body = _prepared(r'<p>Let \(\lambda \in F\) and \[x^2\] but not <code>\(raw\)</code>.</p>');
      final spans = body.querySelectorAll('span.math');
      expect(spans.map((s) => s.className), ['math inline', 'math display']);
      expect(spans.map((s) => s.text), [r'\(\lambda \in F\)', r'\[x^2\]']);
      expect(body.text, r'Let \(\lambda \in F\) and \[x^2\] but not \(raw\).');
    });

    test('epub:switch keeps the MathML case, else the fallback', () {
      final body = _prepared('<p><epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML">'
          '<math><mi>x</mi></math></epub:case><epub:default><img src="x.png" alt="x"/></epub:default></epub:switch>'
          ' and <epub:switch><epub:case required-namespace="http://example.org/other"><b>no</b></epub:case>'
          '<epub:default><i>fallback</i></epub:default></epub:switch></p>');
      expect(body.querySelector('math'), isNotNull);
      expect(body.querySelector('img'), isNull);
      expect(body.querySelector('i')!.text, 'fallback');
      expect(body.querySelector('b'), isNull);
    });

    test('equation images keep their em size; publisher display:none stays hidden', () {
      final out = DartReaderView.prepareHtml(_doc(
        '<p>Let <img src="e.png" alt="T" style="height:1.09em; vertical-align:-0.14em;"/> be'
        '<span style="color: inherit; display: none;">dup</span>.</p>',
      ));
      expect(out, contains('data-tr-em-h="1.09"'));
      expect(out, contains('data-tr-em-va="-0.14"'));
      expect(out, isNot(contains('style=')));
      final span = html.parse(out).querySelector('span')!;
      expect(_hidden(span), isTrue);
    });

    test('a formula does not part from the text touching it', () {
      final out = DartReaderView.prepareHtml(_doc('<p>takes (<span><img src="n.png" alt="n" style="height:0.8em"/></span>)-vectors '
          '<math><mi>x</mi></math>, too</p>'));
      expect(out, contains('(⁠<span><img'));
      expect(out, contains('</span>⁠)-vectors'));
      expect(out, contains('</math>⁠, too'));
    });
  });

  group('pdftohtml conversions', () {
    test('an inline wrapper around the whole body is unwrapped; inner italics stay', () {
      final body = _prepared('<i class="c3"><p class="c1">Plain words and <i class="c3">v</i> here.</p>'
          '<p class="c1">More.</p></i>', head: _pdfHead);
      expect(body.children.map((e) => e.localName), ['p', 'p']);
      expect(body.querySelectorAll('i').single.text, 'v');
    });

    test('page numbers and running heads after page anchors are hidden, not removed', () {
      final body = _prepared(
        '<p class="c1">The end of a page.</p>'
        '<p class="c1"><a id="p100"></a>84</p><p class="c1">CHAPTER 3</p><p class="c1">Linear Maps</p>'
        '<p class="c1">Fresh section heading</p>'
        '<p class="c1"><a id="p101"></a>SECTION 3.D</p><p class="c1">Invertibility</p><p class="c1">85</p>'
        '<p class="c1">Body text resumes.</p>'
        '<p class="c1"><a id="p102"></a>86</p><p class="c1">Not a running head at all</p>',
        head: _pdfHead,
      );
      final ps = body.querySelectorAll('p');
      expect([for (final p in ps) if (!_hidden(p)) p.text], [
        'The end of a page.',
        'Fresh section heading',
        'Body text resumes.',
        'Not a running head at all',
      ]);
      expect(ps.where(_hidden), hasLength(7));
      expect(body.text, contains('CHAPTER 3'));
    });

    test('hard-broken lines join when a sentence clearly continues', () {
      final body = _prepared(
        '<p class="c1">Note that the triangle inequality im-</p>\n<p class="c1">plies that the shortest path</p>\n'
        '<p class="c1">between two points is a segment.</p>\n<p class="c1">3.62</p>\n<p class="c1">Definition text.</p>\n'
        '<p class="c1">A complete sentence ends here.</p>\n<p class="c1">lowercase start stays apart.</p>',
        head: _pdfHead,
      );
      final visible = [for (final p in body.querySelectorAll('p')) if (!_hidden(p)) p.text];
      expect(visible, [
        'Note that the triangle inequality im-plies that the shortest path\nbetween two points is a segment.',
        '3.62',
        'Definition text.',
        'A complete sentence ends here.',
        'lowercase start stays apart.',
      ]);
    });

    test('lines join across hidden page furniture', () {
      final body = _prepared(
        '<p class="c1">every finite-dimensional vector space is iso</p>'
        '<p class="c1"><a id="p9"></a>12</p><p class="c1">CHAPTER 1</p><p class="c1">Vector Spaces</p>'
        '<p class="c1">morphic to some list space.</p>',
        head: _pdfHead,
      );
      final visible = [for (final p in body.querySelectorAll('p')) if (!_hidden(p)) p.text];
      expect(visible, ['every finite-dimensional vector space is iso morphic to some list space.']);
    });

    test('a long paragraph between a running head and a number is not page furniture', () {
      final long = 'Suppose U is a subspace of V. ' * 4;
      final body = _prepared(
        '<p class="c1"><a id="p9"></a>SECTION 3.D</p><p class="c1">$long</p><p class="c1">3</p>',
        head: _pdfHead,
      );
      final visible = [for (final p in body.querySelectorAll('p')) if (!_hidden(p)) p.text.trim()];
      expect(visible, contains(long.trim()));
    });

    test('calibre output with page anchors is recognised without a generator tag', () {
      final pages = [for (var i = 1; i <= 6; i++) '<p class="calibre1"><a id="p$i"></a>$i</p><p class="calibre1">Text.</p>'];
      final body = _prepared('<i class="calibre3">${pages.join()}</i>');
      expect(body.querySelector('i'), isNull);
      expect(body.querySelectorAll('p').where(_hidden), hasLength(6));
    });

    test('ordinary books are left alone', () {
      const prose = '<i><p>A styled block quote.</p></i><p><a id="p1"></a>12</p>'
          '<p>a line that ends without a stop</p><p>and continues here.</p>';
      final body = _prepared(prose);
      expect(body.querySelector('i'), isNotNull);
      expect(body.querySelectorAll('p').where(_hidden), isEmpty);
      // Without math or PDF signals the markup takes the old string path.
      expect(DartReaderView.prepareHtml(_doc(prose)), prose);
    });
  });
}
