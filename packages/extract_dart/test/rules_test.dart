import 'package:test/test.dart';
import 'package:thereader_extract/thereader_extract.dart';

// Single rules on small pages; the same cases as packages/extract/test/rules.test.ts.

final _prose = 'Some long prose sentence here to pass thresholds. ' * 15;

/// An article of [body] between two long paragraphs.
Article _article(String body) => extractHtml(
  '<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1>'
      '<p>$_prose</p>$body<p>$_prose</p></article></body></html>',
  'https://example.com/a',
)!;

List<Object?> _blocks(String body) => [for (final b in _article(body).blocks) b.toJson()];

void main() {
  test('a note marker cleaning removed stays removed when the note is not taken', () {
    const body =
        '<p>Claim<span class="sidenote"><sup class="noprint">7</sup><span class="sidenote-content"></span> (see the appendix)</span> rest.</p>';
    expect(_blocks(body)[1], {
      'type': 'paragraph',
      'content': [
        {'type': 'text', 'text': 'Claim (see the appendix) rest.'},
      ],
    });
  });
}
