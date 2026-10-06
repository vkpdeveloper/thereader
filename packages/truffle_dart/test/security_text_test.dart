import 'package:html/parser.dart' as html_parser;
import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

// Hostile text that made a pattern backtrack for seconds or minutes, through the public API: each page must extract
// well within the bound (the old patterns took many seconds on these sizes), and the pattern must still do its job.
// The same cases as packages/truffle/test/security-text.test.ts.

final _prose = 'Some long prose sentence here to pass thresholds. ' * 15;
const _boundMs = 1000;

String _html(String head, String body) =>
    '<html><head>$head</head><body><article>$body<p>$_prose</p></article></body></html>';

Article _page(String head, String body, [String url = 'https://example.com/a']) => extractHtml(_html(head, body), url)!;

/// Extracts and checks the time spent (HTML parsing excluded).
Article _timed(String head, String body) {
  final doc = html_parser.parse(_html(head, body));
  final watch = Stopwatch()..start();
  final article = extractTree(fromDocument(doc), 'https://example.com/a')!;
  expect(watch.elapsedMilliseconds, lessThan(_boundMs));
  return article;
}

String _plain(Block b) => switch (b) {
  ParagraphBlock() => inlineText(b.content),
  HeadingBlock() => inlineText(b.content),
  _ => b.toJson()['type'] as String,
};

void main() {
  test('a run of capitalised names that is no byline does not backtrack', () {
    final line = 'By ${'AAAAA,' * 8}AAAAA1';
    expect(_timed('<title>Rule test page</title>', '<h1>Rule test page</h1><p>$line</p>').blocks.map(_plain), [
      line,
      _prose.trim(),
    ]);
    // A byline still goes.
    for (final byline in [
      'By Jane Doe',
      'By JANE DOE and Li Wei | Reuters',
      "By Jean-Paul O'Brien",
      'By J.R.R. Tolkien',
    ]) {
      expect(_page('<title>Rule test page</title>', '<h1>Rule test page</h1><p>$byline</p>').blocks.map(_plain), [
        _prose.trim(),
      ]);
    }
  });

  test('a title with a long run of no-break spaces does not backtrack', () {
    final spaces = '&nbsp;' * 50000;
    _timed('<title>a${spaces}b</title>', '<h1>Rule test page</h1><h2>a${spaces}b</h2><p>$_prose</p>');
    _timed('<title>a${spaces}b</title><meta property="og:title" content="a${'\u3000' * 20000}b">', '<p>$_prose</p>');
    // The site name still comes off a title separated by no-break spaces, and is still read from it.
    expect(
      _page('<title>A Story About Things&nbsp;|&nbsp;Example</title>', '<p>$_prose</p>').title,
      'A Story About Things',
    );
    expect(
      _page(
        '<title>Story&nbsp;-&nbsp;Wikipedia</title>',
        '<p>$_prose</p>',
        'https://en.wikipedia.org/wiki/Story',
      ).siteName,
      'Wikipedia',
    );
  });

  test('author names with a long run of no-break spaces do not backtrack', () {
    final a = _timed(
      '<title>Rule test page</title><meta name="author" content="Ann${'&nbsp;' * 50000}Lee">',
      '<p>$_prose</p>',
    );
    expect(a.authors, isEmpty);
    // Names are still split and trimmed.
    expect(
      _page(
        '<title>Rule test page</title><meta name="author" content="Ann Lee and Bo Chen, ">',
        '<p>$_prose</p>',
      ).authors,
      ['Ann Lee', 'Bo Chen'],
    );
  });

  test('an embed author line with a long run of spaces does not backtrack', () {
    String embed(String last) =>
        '<p>$_prose</p><blockquote class="twitter-tweet"><p>Hello world.</p>'
        '<p>$last <a href="https://twitter.com/jane/status/123">link</a></p></blockquote>';
    _timed('<title>Rule test page</title>', embed('-${'\u3000' * 3000}x'));
    // The author is still read from the tweet's last line.
    final a = _page(
      '<title>Rule test page</title>',
      '<p>$_prose</p><blockquote class="twitter-tweet"><p>Hello world.</p>'
          '<p>\u2014 Jane Doe (@jane) <a href="https://twitter.com/jane/status/123">March 1, 2020</a></p></blockquote>',
    );
    expect(a.blocks.whereType<EmbedBlock>().single.toJson(), containsPair('author', 'Jane Doe (@jane)'));
  });

  test('code with long runs of blank lines or spaces does not backtrack in language detection', () {
    final blocks = [
      'x${'\n' * 4990}!',
      'var${' ' * 4990}!',
      'function${'\n\t' * 2490}!',
      'import${'\t ' * 2490}!',
      'fragment${'\n\t' * 2490}!',
      '${'1' * 4990}!',
    ];
    _timed('<title>Rule test page</title>', blocks.map((code) => '<pre>$code</pre><p>$_prose</p>').join());
    // Detection still works.
    const python = 'import os\n\n\n\ndef main(argv):\n    for name in argv:\n        print(name)\n';
    final a = _page('<title>Rule test page</title>', '<p>$_prose</p><pre>$python</pre>');
    expect(a.blocks.whereType<CodeBlock>().single.language, 'python');
  });

  test('long icon sizes and placeholder-like image names do not backtrack', () {
    final a = _timed(
      '<title>Rule test page</title><link rel="icon" sizes="${'1' * 100000}" href="/icon.png">'
          '<meta property="og:image" content="https://example.com/${'logo' * 25000}">',
      '<p>$_prose</p>',
    );
    expect(a.favicon, 'https://example.com/icon.png');
    // A placeholder lead image is still skipped; a photo is shown.
    String lead(String src) =>
        _page(
              '<title>Rule test page</title><meta property="og:image" content="$src">',
              '<p>$_prose</p>',
            ).blocks.first.toJson()['type']
            as String;
    expect(lead('https://example.com/site-logo.png'), 'paragraph');
    expect(lead('https://example.com/photo.jpg'), 'figure');
  });
}
