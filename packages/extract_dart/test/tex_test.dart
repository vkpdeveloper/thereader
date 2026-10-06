import 'package:test/test.dart';
import 'package:thereader_extract/thereader_extract.dart';

/// A page that uses TeX (`\(...\)`), with [paragraph] as its second block.
Article? _page(String paragraph) {
  final prose = 'Some long prose sentence here to pass thresholds. ' * 15;
  final more = 'More prose here to make the article long enough. ' * 10;
  return extractHtml(
    '<html><head><title>Tex test page</title></head><body><article><h1>Tex test page</h1>'
    '<p>$prose</p><p>$paragraph</p><p>$more</p></article></body></html>',
    'https://example.com/a',
  );
}

void main() {
  test(r'a formula after text holding a $ comes out twice, as in TypeScript', () {
    // TypeScript (bun, jsdom): the shared /g pattern restarts after the text before the formula.
    expect(_page(r'Costs $5, see \(x\) here')!.blocks[1].toJson(), {
      'type': 'paragraph',
      'content': [
        {'type': 'text', 'text': r'Costs $5, see '},
        {'type': 'math', 'tex': 'x', 'text': 'x'},
        {'type': 'math', 'tex': 'x', 'text': 'x'},
        {'type': 'text', 'text': ' here'},
      ],
    });
  });

  test(r'TeX input that never finishes in TypeScript terminates', () {
    expect(_page(r'one \(a\) $ \(b\) end'), isNotNull);
  });
}
