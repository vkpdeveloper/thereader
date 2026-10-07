import 'package:test/test.dart';
import 'package:truffle/src/url.dart';

/// `whatwgHref` resolves common references by concatenation; with assertions
/// enabled (as `dart test` runs) each such result is also checked against the
/// full parser.
void main() {
  const base = 'https://example.com/wiki/Page';
  const cases = {
    '//danluu.com/x/': 'https://danluu.com/x/',
    '//danluu.com': 'https://danluu.com/',
    '//EXAMPLE.org/Path': 'https://example.org/Path',
    '//1.2.3.4/x': 'https://1.2.3.4/x',
    '//host:8080/x': 'https://host:8080/x',
    '/wiki/Riemann–Lebesgue_lemma': 'https://example.com/wiki/Riemann%E2%80%93Lebesgue_lemma',
    'https://ru.wikipedia.org/wiki/Москва': 'https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0',
    '#Even–odd': 'https://example.com/wiki/Page#Even%E2%80%93odd',
    'Café?q=é#é': 'https://example.com/wiki/Caf%C3%A9?q=%C3%A9#%C3%A9',
    'https://例え.jp/x': 'https://xn--r8jz45g.jp/x',
    '/a/../b': 'https://example.com/b',
    '\u{1F600}': 'https://example.com/wiki/%F0%9F%98%80',
  };
  cases.forEach((input, expected) {
    test(input, () => expect(whatwgHref(input, base), expected));
  });
}
