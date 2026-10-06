import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

// Single rules on small pages; the same cases as packages/truffle/test/rules.test.ts.

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

  test('an author block above the text is not a paragraph; author names further down stay', () {
    const authors =
        '<div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Ann Lee</span></span> '
        '<span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bo Chen</span><span class="ltx_author_notes">'
        '<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>Carla Diaz, Dev Patel, Eve Martin, University of Somewhere, Department of Examples</span>'
        '<span class="ltx_contact ltx_role_email">bo@example.org</span></span></span></div>';
    const later = '<p>Cited: <span class="authors">Ann Lee and Bo Chen</span>, An example, 2020.</p>';
    final article = extractHtml(
      '<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1>$authors<p>$_prose</p>$later'
          '</article></body></html>',
      'https://example.com/a',
    )!;
    expect(article.byline, 'Ann Lee');
    expect(
      [for (final b in article.blocks) b is ParagraphBlock ? inlineText(b.content) : b.toJson()['type']],
      [_prose.trim(), 'Cited: Ann Lee and Bo Chen, An example, 2020.'],
    );
  });

  test('a canonical URL that only drops https on the same host keeps https', () {
    String url(String canonical, String page) => extractHtml(
      '<html><head><title>Rule test page</title><link rel="canonical" href="$canonical"></head><body><article>'
      '<h1>Rule test page</h1><p>$_prose</p></article></body></html>',
      page,
    )!.url;
    expect(
      url('http://distill.pub/2017/momentum', 'https://distill.pub/2017/momentum/'),
      'https://distill.pub/2017/momentum',
    );
    expect(url('http://www.example.com/a', 'https://example.com/a'), 'http://www.example.com/a');
    expect(url('http://example.com/a', 'http://example.com/b'), 'http://example.com/a');
  });

  test('a credit closing a caption goes to the credit; elements never glue a sentence to the next', () {
    String figure(String caption) =>
        '<figure><img src="https://example.com/${caption.length}.jpg" width="800" height="600"><figcaption>$caption</figcaption></figure>';
    final blocks = _blocks(
      [
        figure('The theatre in Perth, Western Australia.<small>Photograph: Gavin M John/The Guardian</small>'),
        figure('The tomb of King Djer, in Abydos. Photograph: Mike P Shepherd/Alamy'),
        figure('Image: Jose Mourinho, left, has replaced Mauricio Pochettino'),
        '<p>Rep. Omar speaks at the Capitol on July 25, 2019.<span>J. Scott Applewhite / AP file</span> In '
            '<code>asyncio.</code><code>TaskGroup</code>, see <span>asyncio.</span><span>TaskGroup</span>.</p>',
      ].join(),
    );
    List<Object?> text(String t) => [
      {'type': 'text', 'text': t},
    ];
    expect(
      [for (final b in blocks.sublist(1, 4)) (b as Map)['caption']],
      [
        text('The theatre in Perth, Western Australia.'),
        text('The tomb of King Djer, in Abydos.'),
        text('Image: Jose Mourinho, left, has replaced Mauricio Pochettino'),
      ],
    );
    expect(
      [for (final b in blocks.sublist(1, 4)) (b as Map)['credit']],
      [text('Photograph: Gavin M John/The Guardian'), text('Photograph: Mike P Shepherd/Alamy'), null],
    );
    expect(blocks[4], {
      'type': 'paragraph',
      'content': [
        {'type': 'text', 'text': 'Rep. Omar speaks at the Capitol on July 25, 2019. J. Scott Applewhite / AP file In '},
        {
          'type': 'text',
          'text': 'asyncio.TaskGroup',
          'marks': ['code'],
        },
        {'type': 'text', 'text': ', see asyncio.TaskGroup.'},
      ],
    });
  });

  test('the lead of a topic-tag footer at the end goes; the same words inside the article stay', () {
    List<Object?> blocks(String body) => [
      for (final b in extractHtml(
        '<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1><p>$_prose</p>$body'
            '</article></body></html>',
        'https://example.com/a',
      )!.blocks)
        b is ParagraphBlock ? inlineText(b.content) : b.toJson()['type'],
    ];
    expect(blocks('<p>The play opens on Friday.</p><p>Explore more on these topics</p>'), [
      _prose.trim(),
      'The play opens on Friday.',
    ]);
    expect(blocks('<p>Related topics:</p><p>The play opens on Friday.</p>'), [
      _prose.trim(),
      'Related topics:',
      'The play opens on Friday.',
    ]);
  });

  test('a video file and its still image are one video carrying the figure caption', () {
    String video(String poster) =>
        '<video src="/media/clip.mp4" $poster aria-label="The sidebar loading" width="1320" height="900"></video>';
    const still = '<img class="still" src="/media/clip.png" alt="The sidebar loading" width="1320" height="900">';
    const caption = '<figcaption><b>FIG A</b> Sidebar jank</figcaption>';
    final bare = {
      'type': 'video',
      'provider': 'file',
      'url': 'https://example.com/media/clip.mp4',
      'poster': 'https://example.com/media/clip.png',
    };
    final one = {
      ...bare,
      'caption': [
        {
          'type': 'text',
          'text': 'FIG A',
          'marks': ['bold'],
        },
        {'type': 'text', 'text': ' Sidebar jank'},
      ],
    };
    List<Object?> inner(String body) {
      final blocks = _blocks(body);
      return blocks.sublist(1, blocks.length - 1);
    }

    // The still repeats the poster, after or before the video; without a poster the still becomes it.
    expect(inner('<figure><div>${video('poster="/media/clip.png"')}$still</div>$caption</figure>'), [one]);
    expect(inner('<figure>$still${video('poster="/media/clip.png"')}$caption</figure>'), [one]);
    expect(inner('<figure>${video('')}$still$caption</figure>'), [one]);
    // Outside a figure, a still right after the video (or in its <noscript>) is dropped.
    expect(inner('<div>${video('poster="/media/clip.png"')}<noscript>$still</noscript></div>'), [bare]);
    expect(inner('<div>${video('poster="/media/clip.png"')}$still</div>'), [bare]);
    // A different image in the figure stays a figure.
    final other = inner(
      '<figure>${video('poster="/media/clip.png"')}<img src="/media/chart.png" alt="Chart" width="1320" height="900">$caption</figure>',
    );
    expect([for (final b in other) (b as Map)['type']], ['figure', 'video']);
  });

  test('a marker typed into a list item that repeats the list marker goes', () {
    List<List<Object?>> texts(String body) => [
      for (final b in _article(body).blocks.sublist(1, _article(body).blocks.length - 1))
        if (b is ListBlock)
          for (final i in b.items) [for (final x in i.blocks) x is ParagraphBlock ? inlineText(x.content) : x.type],
    ];
    expect(
      texts(
        '<ul><li>• One</li><li><span class="dot">•</span>Two</li><li>- Three</li><li>•<div><p>Four</p></div></li></ul>',
      ),
      [
        ['One'],
        ['Two'],
        ['Three'],
        ['Four'],
      ],
    );
    expect(texts('<ol start="4"><li>4. Four</li><li>5) Five</li><li value="9">(9) Nine</li></ol>'), [
      ['Four'],
      ['Five'],
      ['Nine'],
    ]);
    // Numbers that are not the item's own, numbers in a bulleted list and words that start with a dash stay.
    expect(texts('<ol><li>2024. A year</li><li>7. Seven</li></ol><ul><li>1. First</li><li>-1 degrees</li></ul>'), [
      ['2024. A year'],
      ['7. Seven'],
      ['1. First'],
      ['-1 degrees'],
    ]);
  });
}
