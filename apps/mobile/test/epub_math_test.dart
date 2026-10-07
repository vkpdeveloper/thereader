import 'package:flutter_test/flutter_test.dart';
import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;
import 'package:thereader/reader/dart_engine/epub_tex.dart';
import 'package:thereader/reader/dart_engine/mathml_tex.dart';

/// MathML → TeX conversion and TeX clean-up for the Dart engine. Every
/// snippet is original; outputs must also parse in flutter_math_fork.

dom.Element _math(String markup) => html.parse('<body>$markup</body>').querySelector('math')!;

String _tex(String inner, {String attrs = ''}) {
  final tex = MathmlTex.of(_math('<math$attrs>$inner</math>'));
  expect(EpubTex.tryParse(EpubTex.normalize(tex)), isNotNull, reason: 'does not parse: $tex');
  return tex.replaceAll(RegExp(r'\s+'), ' ').trim();
}

void main() {
  group('MathML to TeX', () {
    test('tokens: identifiers, numbers, operators, text and space', () {
      expect(_tex('<mi>x</mi><mo>+</mo><mn>2</mn>'), 'x + 2');
      expect(_tex('<mi>sin</mi><mo>&#x2061;</mo><mi>θ</mi>'), r'\sin \theta');
      expect(_tex('<mi>rank</mi>'), r'\mathrm{rank}');
      expect(_tex('<mi mathvariant="normal">d</mi><mi>x</mi>'), r'\mathrm{d} x');
      expect(_tex('<mi mathvariant="double-struck">R</mi>'), r'\mathbb{R}');
      expect(_tex('<mi>ℝ</mi><mo>∈</mo><mi>𝔽</mi>'), r'\mathbb{R} \in \mathbb{F}');
      expect(_tex('<mi mathvariant="bold">v</mi>'), r'\mathbf{v}');
      expect(_tex('<mtext>for all </mtext><mi>n</mi>'), r'\text{for all } n');
      expect(_tex('<mi>a</mi><mspace width="1em"/><mi>b</mi>'), r'a \quad b');
      expect(_tex('<mi>a</mi><mo>≤</mo><mi>b</mi><mo>≠</mo><mi>c</mi>'), r'a \le b \ne c');
      expect(_tex('<mo>{</mo><mi>x</mi><mo>#</mo>'), r'\{ x \#');
    });

    test('scripts, fractions and radicals', () {
      expect(_tex('<msub><mi>x</mi><mn>1</mn></msub>'), 'x_{1}');
      expect(_tex('<msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup>'), r'e^{i \pi}');
      expect(_tex('<msubsup><mi>a</mi><mi>k</mi><mn>2</mn></msubsup>'), 'a_{k}^{2}');
      expect(_tex('<msup><mrow><mo>(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo>)</mo></mrow><mn>2</mn></msup>'),
          r'{\left( a + b \right)}^{2}');
      expect(_tex('<msup><mi>f</mi><mo>′</mo></msup>'), r'f^{\prime}');
      expect(_tex('<mfrac><mn>1</mn><mi>n</mi></mfrac>'), r'\frac{1}{n}');
      expect(_tex('<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>'), r'\genfrac{}{}{0pt}{}{n}{k}');
      expect(_tex('<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>'), r'\sqrt{x + 1}');
      expect(_tex('<mroot><mi>x</mi><mn>3</mn></mroot>'), r'\sqrt[3]{x}');
    });

    test('accents, limits and braces', () {
      expect(_tex('<mover><mi>v</mi><mo>→</mo></mover>'), r'\vec{v}');
      expect(_tex('<mover accent="true"><mrow><mi>A</mi><mi>B</mi></mrow><mo>→</mo></mover>'), r'\overrightarrow{A B}');
      expect(_tex('<mover><mi>x</mi><mo>^</mo></mover>'), r'\hat{x}');
      expect(_tex('<mover><mi>z</mi><mo>¯</mo></mover>'), r'\overline{z}');
      expect(
        _tex('<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msub><mi>a</mi><mi>i</mi></msub>'),
        r'\sum_{i = 1}^{n} a_{i}',
      );
      expect(_tex('<munder><mo>lim</mo><mrow><mi>n</mi><mo>→</mo><mi>∞</mi></mrow></munder>'), r'\lim_{n \to \infty}');
      expect(_tex('<munder><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mo>⏟</mo></munder>'), r'\underbrace{a + b}');
      expect(_tex('<mover><mo>=</mo><mtext>def</mtext></mover>'), r'\overset{\text{def}}{=}');
      expect(_tex('<munder><mi>x</mi><mi>y</mi></munder>'), r'\underset{y}{x}');
    });

    test('tables become matrices; fences grow around them', () {
      const rows = '<mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr>';
      expect(_tex('<mrow><mo>[</mo><mtable>$rows</mtable><mo>]</mo></mrow>'),
          r'\left[ \begin{matrix} 1 & 0 \\ 0 & 1 \end{matrix} \right]');
      expect(_tex('<mtable columnalign="right left">$rows</mtable>'), r'\begin{array}{rl} 1 & 0 \\ 0 & 1 \end{array}');
      expect(_tex('<mfenced><mi>a</mi><mi>b</mi></mfenced>'), r'\left( a , b \right)');
      expect(_tex('<mfenced open="{" close=""><mi>x</mi></mfenced>'), r'\left\{ x \right.');
      expect(_tex('<mfenced open="⟨" close="⟩" separators="|"><mi>u</mi><mi>v</mi></mfenced>'), r'\left\langle u | v \right\rangle');
      expect(_tex('<mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow>'), r'\left| x \right|');
    });

    test('styles, semantics, enclosures and unknown markup', () {
      expect(_tex('<mstyle displaystyle="true"><mfrac><mi>a</mi><mi>b</mi></mfrac></mstyle>'), r'{\displaystyle \frac{a}{b}}');
      expect(_tex('<menclose notation="box"><mi>x</mi></menclose>'), r'\boxed{x}');
      expect(_tex('<mphantom><mi>x</mi></mphantom>'), r'\phantom{x}');
      expect(_tex('<mmultiscripts><mi>C</mi><mprescripts/><mi>n</mi><mi>k</mi></mmultiscripts>'), r'{}_{n}^{k}{C}');
      expect(_tex('<semantics><mrow><mi>a</mi></mrow><annotation encoding="text/plain">a</annotation></semantics>'), 'a');
      expect(_tex('<mrow><mi>x</mi><mfoo><mi>y</mi></mfoo></mrow>'), 'x y');
      expect(_tex(r'<mi>\</mi><mi>_</mi><mi>%</mi>'), r'\backslash \_ \%');
    });

    test('a TeX annotation wins over the presentation markup', () {
      final math = _math('<math display="block"><semantics><mrow><mi>x</mi></mrow>'
          r'<annotation encoding="application/x-tex">\frac{a}{b}</annotation></semantics></math>');
      expect(MathmlTex.of(math), r'\frac{a}{b}');
      expect(MathmlTex.isDisplay(math), isTrue);
      expect(MathmlTex.isDisplay(_math('<math><mi>x</mi></math>')), isFalse);
    });

    test('prefixed MathML is read the same', () {
      final math = html.parse('<body><m:math><m:msup><m:mi>x</m:mi><m:mn>2</m:mn></m:msup></m:math></body>')
          .querySelector('body')!
          .children
          .first;
      expect(MathmlTex.convert(math).replaceAll(' ', ''), 'x^{2}');
    });
  });

  group('TeX sources', () {
    test('delimiters, unsupported environments and common macros', () {
      expect(EpubTex.normalize(r'\(x^2\)'), 'x^2');
      expect(EpubTex.normalize(r'\[ a \]'), 'a');
      expect(EpubTex.normalize(r'$$a+b$$'), 'a+b');
      expect(EpubTex.normalize(r'\begin{align*}a&=b\\c&=d\end{align*}'), r'\begin{aligned}a&=b\\c&=d\end{aligned}');
      expect(EpubTex.normalize(r'\begin{equation}x\label{eq:1}\end{equation}'), 'x');
      expect(EpubTex.normalize(r'E=mc^2 \tag{3}'), r'E=mc^2 \qquad(\text{3})');
      for (final tex in [
        r'\textrm{Im}(T) \eqdef \{ \vec{w} \}',
        r'\mathbbm{1}',
        r'\ketbra{0}{1}',
        r'\Tr(A)',
        r'\begin{gather*}a\\b\end{gather*}',
        r'\begin{align}x&=1\end{align}',
      ]) {
        expect(EpubTex.tryParse(EpubTex.normalize(tex)), isNotNull, reason: tex);
      }
      expect(EpubTex.tryParse(r'\notamacro{x}'), isNull);
      expect(EpubTex.tryParse(''), isNull);
    });

    test('image alt text is TeX only when it reads as a formula', () {
      expect(EpubTex.looksLikeTex(r'\vec{v} \in V', mathContext: false), isTrue);
      expect(EpubTex.looksLikeTex('T', mathContext: true), isTrue);
      expect(EpubTex.looksLikeTex('T(x,y) = (x, y, x+y)', mathContext: true), isTrue);
      expect(EpubTex.looksLikeTex('x_1', mathContext: false), isFalse);
      expect(EpubTex.looksLikeTex('T', mathContext: false), isFalse);
      expect(EpubTex.looksLikeTex('A photo of the river at dusk', mathContext: true), isFalse);
      expect(EpubTex.looksLikeTex(r'Plot of \alpha against the time axis', mathContext: false), isFalse);
      expect(EpubTex.looksLikeTex('figure_3.png', mathContext: true), isFalse);
      expect(EpubTex.looksLikeTex('', mathContext: true), isFalse);
    });
  });
}
