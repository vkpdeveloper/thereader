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

  test('a list of bare href="#" links is not a table of contents', () {
    const items = [
      'Basic: 10 GB of storage and email support',
      'Plus: 100 GB of storage and chat support',
      'Pro: 1 TB of storage and phone support',
    ];
    final body = '<p>The plans:</p><ul>${items.map((t) => '<li><a href="#">$t</a></li>').join()}</ul>';
    expect(_blocks(body)[2], {
      'type': 'list',
      'ordered': false,
      'items': [
        for (final text in items)
          {
            'blocks': [
              {
                'type': 'paragraph',
                'content': [
                  {'type': 'text', 'text': text},
                ],
              },
            ],
          },
      ],
    });
    // Links to places on the page are one.
    expect(
      [for (final b in _article(body.replaceAll('href="#"', 'href="#plans"')).blocks) b.toJson()['type']],
      ['paragraph', 'paragraph', 'paragraph'],
    );
  });

  test('short texts positioned over a figure drawn by script are not paragraphs', () {
    const caption = 'Momentum lets a larger range of step-sizes be used, and creates its own oscillations.';
    const body =
        '<figure style="position:relative"><div id="chart"></div><div id="slider" style="position: absolute; left: 20px">'
        '<text class="figtext">Step-size α = 0.02</text></div><figcaption style="position:absolute">$caption</figcaption></figure>';
    final blocks = _blocks(body);
    expect(blocks.sublist(1, blocks.length - 1), [
      {
        'type': 'paragraph',
        'content': [
          {'type': 'text', 'text': caption},
        ],
      },
    ]);
    // Positioned text that is no label (a quote set in a figure) stays.
    expect(_blocks('<figure><blockquote style="position:absolute">Quoted words.</blockquote></figure>')[1], {
      'type': 'quote',
      'blocks': [
        {
          'type': 'paragraph',
          'content': [
            {'type': 'text', 'text': 'Quoted words.'},
          ],
        },
      ],
    });
  });

  test('the byline is the first name in an author widget', () {
    final article = extractHtml(
      '<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1>'
          '<div class="author"><span itemprop="name">By Ann Lee</span> <span itemprop="name">MARCH 20, 2019 10:43</span></div>'
          '<p>$_prose</p></article></body></html>',
      'https://example.com/a',
    )!;
    expect(article.byline, 'Ann Lee');
  });
}
