import 'package:html/parser.dart' as html_parser;
import 'package:test/test.dart';
import 'package:truffle/src/js.dart';
import 'package:truffle/src/url.dart';
import 'package:truffle/truffle.dart';

// Hostile frame, image and TeX markup that sent the old patterns into quadratic backtracking (seconds
// to minutes for one page); the same cases as packages/truffle/test/security-media.test.ts, sized
// for the Dart VM (its regexes are slower: these took the old code from seconds to over a minute).
// Each page is parsed outside the timing and must extract in well under a second, and ordinary
// markup keeps its result.

final _prose = 'Some long prose sentence here to pass thresholds. ' * 15;
const _limit = Duration(seconds: 1);

VDocument _parse(String body, [String head = '']) => fromDocument(
  html_parser.parse(
    '<html><head><title>Security test page</title>$head</head><body><article><h1>Security test page</h1>'
    '<p>$_prose</p>$body<p>$_prose</p></article></body></html>',
  ),
);

Article _article(String body, [String head = '']) => extractTree(_parse(body, head), 'https://example.com/a')!;

/// The article, extracted within [_limit] (parsing not counted).
Article _quick(String body, [String head = '']) {
  final doc = _parse(body, head);
  final watch = Stopwatch()..start();
  final result = extractTree(doc, 'https://example.com/a')!;
  expect(watch.elapsed, lessThan(_limit));
  return result;
}

/// The blocks between the two prose paragraphs (`blocks.slice(1, -1)`).
List<Object?> _middle(Article a) => [for (var k = 1; k < a.blocks.length - 1; k++) a.blocks[k].toJson()];

String _frame(String src) => '<iframe src="${src.replaceAll('&', '&amp;')}"></iframe>';

/// Pages the old patterns took seconds on.
final _hostile = <(String, String, String)>[
  ('a YouTube frame URL repeating its prefix', _frame('https://www.${'youtube.com/watch?' * 5000}'), ''),
  ('a Twitch frame URL repeating its prefix', _frame('https://${'player.twitch.tv/?' * 5000}'), ''),
  ('a SoundCloud frame URL repeating its prefix', _frame('https://${'w.soundcloud.com/player/?' * 5000}'), ''),
  ('a Bilibili frame URL repeating its prefix', _frame('https://${'player.bilibili.com/player.html?' * 5000}'), ''),
  ('a tweet frame URL repeating its prefix', _frame('https://${'platform.twitter.com/embed/Tweet.html?' * 4000}'), ''),
  (
    'a video source repeating the YouTube prefix',
    '<video src="https://www.${'youtube.com/watch?' * 5000}"></video>',
    '',
  ),
  // A parameter on another line than the prefixes cannot be reached from them.
  (
    'a video source with the parameter on its own line',
    '<video src="https://www.${'youtube.com/watch?' * 5000}\n&amp;v=dQw4w9WgXcQ"></video>',
    '',
  ),
  ('an image name repeating a placeholder word', '<p><img src="https://example.com/${'blank' * 20000}"></p>', ''),
  (
    'a srcset with long numbers',
    '<p><img src="https://example.com/a.jpg" srcset="https://example.com/b.jpg ${'1' * 20000}, https://example.com/c.jpg ${'2' * 20000}y"></p>',
    '',
  ),
  (
    'a srcset URL with a long run of commas',
    '<p><img srcset="https://example.com/a${',' * 50000}b, https://example.com/c.jpg 2x"></p>',
    '',
  ),
  ('an image width padded with spaces', '<p><img src="https://example.com/a.jpg" width="1${' ' * 50000}x"></p>', ''),
  ('icon sizes with a long number', '', '<link rel="icon" href="/f.png" sizes="${'1' * 20000}">'),
  (
    'an og:image size with a long number',
    '',
    '<meta property="og:image" content="https://example.com/a.jpg"><meta property="og:image:width" content="${'1' * 20000}x">'
        '<meta property="og:image:height" content="0o${'7' * 100000}">',
  ),
  ('a link to a long non-ASCII host', '<p>See <a href="https://${_ideographs(20000)}.com/">this</a>.</p>', ''),
  ('unclosed \\[ delimiters', '<p>${r'\[' * 20000}</p>', ''),
  ('unclosed \\( delimiters', '<p>${r'\(' * 20000}</p>', ''),
  ('unclosed \\[ delimiters on a TeX page', '<p>\\(x\\) ${r'\[ ' * 20000}</p>', ''),
  ('formulas inside one long \\[ formula', '<p>${r'\(x\[x\)' * 12000}\\]</p>', ''),
  ('code with a long run of spaces', '<pre>a${' ' * 100000}b</pre>', ''),
  (
    'table code with a long run of spaces',
    '<table class="highlight"><tr><td class="blob-num">1</td><td class="blob-code">a${' ' * 100000}b</td></tr>'
        '<tr><td class="blob-num">2</td><td class="blob-code">c</td></tr></table>',
    '',
  ),
];

/// [count] distinct CJK ideographs.
String _ideographs(int count) => String.fromCharCodes([for (var c = 0x4e00; c < 0x4e00 + count; c++) c]);

void main() {
  for (final (name, body, head) in _hostile) {
    test('$name extracts quickly', () => _quick(body, head));
  }

  test('player frames still become videos and audio', () {
    expect(_middle(_article(_frame('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'))), [
      {
        'type': 'video',
        'provider': 'youtube',
        'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'embedUrl': 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        'poster': 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      },
    ]);
    Object? url(String src) => (_middle(_article(_frame(src)))[0] as Map)['url'];
    // The last `&v=` on the line wins, as with the regex.
    expect(
      url('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=x&v=BBBBBBBBBBB'),
      'https://www.youtube.com/watch?v=BBBBBBBBBBB',
    );
    // The leftmost match wins across the alternatives.
    expect(
      url('https://example.com/?a=youtube.com/watch?x=1&v=CCCCCCCCCCC&b=youtu.be/DDDDDDDDDDD'),
      'https://www.youtube.com/watch?v=CCCCCCCCCCC',
    );
    expect(
      url('https://player.twitch.tv/?parent=example.com&channel=somechannel'),
      'https://www.twitch.tv/somechannel',
    );
    expect(
      url(
        'https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123&auto_play=false',
      ),
      'https://api.soundcloud.com/tracks/123',
    );
    expect(
      url('https://player.bilibili.com/player.html?aid=1&bvid=BV1xx411c7mD&page=1'),
      'https://www.bilibili.com/video/BV1xx411c7mD',
    );
    expect(_middle(_article(_frame('https://platform.twitter.com/embed/Tweet.html?dnt=true&id=1234567890'))), [
      {'type': 'embed', 'provider': 'twitter', 'url': 'https://twitter.com/i/status/1234567890'},
    ]);
  });

  test('placeholders, srcsets, sizes and favicons read as before', () {
    List<Object?> figure(Map<String, Object?> image) => [
      {
        'type': 'figure',
        'images': [image],
      },
    ];
    // A placeholder src gives way to the lazy source.
    expect(
      _middle(
        _article(
          '<p><img src="https://example.com/img/lazy-load-blank.gif" data-src="https://example.com/real.jpg" alt="A cat"></p>',
        ),
      ),
      figure({'src': 'https://example.com/real.jpg', 'alt': 'A cat'}),
    );
    expect(_middle(_article('<p><img src="https://example.com/img/blank.gif?v=2" alt="A cat"></p>')), isEmpty);
    // Widths and densities, the largest up to 1600px chosen.
    expect(
      _middle(
        _article(
          '<p><img src="https://example.com/s.jpg" srcset="https://example.com/m.jpg 800w, https://example.com/l.jpg 1200w" alt="A cat"></p>',
        ),
      ),
      figure({
        'src': 'https://example.com/l.jpg',
        'alt': 'A cat',
        'srcset': 'https://example.com/m.jpg 800w, https://example.com/l.jpg 1200w',
      }),
    );
    expect(
      _middle(
        _article('<p><img srcset="https://example.com/a.jpg 1.5x, https://example.com/b.jpg 2x" alt="A cat"></p>'),
      ),
      figure({
        'src': 'https://example.com/b.jpg',
        'alt': 'A cat',
        'srcset': 'https://example.com/a.jpg 1.5x, https://example.com/b.jpg 2x',
      }),
    );
    expect(
      _middle(_article('<p><img src="https://example.com/a.jpg" width=" 640px " height="480" alt="A cat"></p>')),
      figure({'src': 'https://example.com/a.jpg', 'alt': 'A cat', 'width': 640, 'height': 480}),
    );
    const icons = '<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/192.png" sizes="any 192x192">';
    expect(_article('', icons).favicon, 'https://example.com/192.png');
  });

  test('TeX is still split out of the text', () {
    // `\[\[z\]` closes at the first `\]`; `\(\)` holds nothing, so it does not close.
    expect(_middle(_article(r'<p>Let \(x^2\) be $y$ and \[\[z\]\] end, \(\) \(a\) b.</p>')), [
      {
        'type': 'paragraph',
        'content': [
          {'type': 'text', 'text': 'Let '},
          {'type': 'math', 'tex': 'x^2', 'text': 'x^2'},
          {'type': 'text', 'text': ' be '},
          {'type': 'math', 'tex': 'y', 'text': 'y'},
          {'type': 'text', 'text': ' and'},
        ],
      },
      {'type': 'math', 'tex': r'\[z', 'text': r'\[z'},
      {
        'type': 'paragraph',
        'content': [
          {'type': 'text', 'text': r'\] end, '},
          {'type': 'math', 'tex': r'\) \(a', 'text': r'\) \(a'},
          {'type': 'text', 'text': ' b.'},
        ],
      },
    ]);
  });

  test('code keeps runs of spaces and loses trailing whitespace', () {
    final spaces = ' ' * 1000;
    expect(_middle(_article('<pre>a${spaces}b</pre>')), [
      {'type': 'code', 'code': 'a${spaces}b', 'language': null},
    ]);
    expect(_middle(_article('<pre>\n${spaces}b \n\t</pre>')), [
      {'type': 'code', 'code': '${spaces}b', 'language': null},
    ]);
    final table =
        '<table class="highlight"><tr><td class="blob-num">1</td><td class="blob-code">a${spaces}b</td></tr>'
        '<tr><td class="blob-num">2</td><td class="blob-code">c  </td></tr></table>';
    expect(_middle(_article(table)), [
      {'type': 'code', 'code': 'a${spaces}b\nc', 'language': null},
    ]);
  });

  test('jsNumber is JavaScript Number(), long numbers included', () {
    final watch = Stopwatch()..start();
    // Expected values from Number() in V8 and JavaScriptCore.
    final cases = <String, double>{
      '0o17': 15,
      '0O17': 15,
      '0b101': 5,
      '0B101': 5,
      '0x1F': 31,
      '0o${'7' * 2000}': double.infinity,
      '0b${'1' * 1100}': double.infinity,
      '0b${'1' * 1024}': double.infinity,
      '0b1${'0' * 1023}': 8.98846567431158e+307,
      '0b1${'0' * 1024}': double.infinity,
      '0o${'0' * 5000}17': 15,
      '0b${'0' * 5000}': 0,
      '0o${'7' * 2000}8': double.nan,
      '0b${'1' * 1500}2': double.nan,
      '0x${'f' * 300}': double.infinity,
      '0x${'f' * 255}': 1.1235582092889474e+307,
      '1' * 400: double.infinity,
      '${'1' * 40000}x': double.nan,
      '${'1' * 1000}.${'1' * 1000}': double.infinity,
      '1.': 1,
      '.5': 0.5,
      '1.5e3': 1500,
      '1e': double.nan,
      '1e+': double.nan,
      '+1': 1,
      '-1.5': -1.5,
      ' 12 ': 12,
      '12px': double.nan,
      '00012': 12,
      '0.': 0,
      '.': double.nan,
      '-': double.nan,
      '1_0': double.nan,
      'Infinity': double.infinity,
      '-Infinity': double.negativeInfinity,
      '1e400': double.infinity,
      '1e-400': 0,
    };
    for (final MapEntry(key: value, value: expected) in cases.entries) {
      final actual = jsNumber(value);
      expect(
        actual.isNaN ? 'NaN' : actual,
        expected.isNaN ? 'NaN' : expected,
        reason: value.length > 40 ? '${value.substring(0, 40)}…' : value,
      );
    }
    expect(jsNumber('0b${'1' * 400000}'), double.infinity);
    expect(jsNumber('0o${'7' * 400000}'), double.infinity);
    expect(watch.elapsed, lessThan(_limit));
  });

  test('IDNA hosts resolve as WHATWG URL does, long ones quickly', () {
    // Expected values from `new URL(input).href` in V8 (ada) and JavaScriptCore.
    final ideographs = [for (var k = 0; k < 40; k++) 0x4e00 + 7 * k];
    final cases = <String, String?>{
      'https://bücher.de/': 'https://xn--bcher-kva.de/',
      'https://mañana.com/a?b#c': 'https://xn--maana-pta.com/a?b#c',
      'https://日本語.jp/': 'https://xn--wgv71a119e.jp/',
      'https://xn--bcher-kva.de/': 'https://xn--bcher-kva.de/',
      'https://café-${'ü' * 40}straße日本${'ä' * 30}.com/':
          'https://xn--caf-strae-n1a0daaaaaaaaaaaaaaaaaaaaaaaaaaaaa2o56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa62492sqfwa.com/',
      'https://Ünïcödé.Example/': 'https://xn--ncd-dma1a7bzb.example/',
      'https://${String.fromCharCodes(ideographs)}a${String.fromCharCodes(ideographs.sublist(0, 10))}.cn/':
          'https://xn--a-zn6ab0ac3bd6ce9df2fg5gh8hi1jj4kk7lxgygzg6gohvhvh2h9hqipiwi3ijjqjxjvj2j9jokvk2k9k6kklrlyl5ljm.cn/',
      'https://xn--abc.com/': null,
      'https://a.b.ñ.c/': 'https://a.b.xn--ida.c/',
    };
    for (final MapEntry(key: input, value: expected) in cases.entries) {
      expect(whatwgHref(input), expected, reason: input);
    }
    // 20,000 distinct code points in one label, and back from Punycode (the RFC's loops are quadratic).
    final watch = Stopwatch()..start();
    final ace = whatwgHref('https://${_ideographs(20000)}.com/')!;
    expect(ace, startsWith('https://xn--'));
    expect(whatwgHref(ace), ace);
    expect(watch.elapsed, lessThan(_limit));
  });
}
