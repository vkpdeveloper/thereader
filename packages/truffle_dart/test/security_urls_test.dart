import 'dart:convert';

import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

// Hostile markup never reaches the model as a script, file or relative URL, a
// borrowed host, or live MathML; the same cases as
// packages/truffle/test/security-urls.test.ts.

final _prose = 'Some long prose sentence here to pass thresholds. ' * 15;

/// An article of [body] between two long paragraphs, as JSON.
Json _article(String body, {String head = '', String url = 'https://example.com/a'}) => extractHtml(
  '<html><head><title>Rule test page</title>$head</head><body><article><h1>Rule test page</h1>'
  '<p>$_prose</p>$body<p>$_prose</p></article></body></html>',
  url,
)!.toJson();

List<Object?> _list(Object? value) => value as List<Object?>;

/// The blocks [body] became, without the surrounding prose (one paragraph
/// when nothing between them was kept).
List<Object?> _blocks(String body) {
  final blocks = _list(_article(body)['blocks']);
  return blocks.length < 2 ? [] : blocks.sublist(1, blocks.length - 1);
}

final _http = RegExp(r'^https?:\/\/[^\s/?#]+');
final _dataImage = RegExp(r'^data:image\/(?:png|jpe?g|gif|webp)[;,]');
final _mailOrTel = RegExp(r'^(?:mailto|tel):');

/// Every URL-bearing field of the article, with the schemes its field allows.
void _expectSafeUrls(Object? value) {
  if (value is List) {
    value.forEach(_expectSafeUrls);
    return;
  }
  if (value is! Map) return;
  value.forEach((k, v) {
    if (v is! String) {
      _expectSafeUrls(v);
      return;
    }
    if (k == 'url' || k == 'embedUrl' || k == 'poster' || k == 'favicon') {
      expect(v, matches(_http));
    } else if (k == 'src') {
      expect(_http.hasMatch(v) || _dataImage.hasMatch(v), isTrue, reason: v);
    } else if (k == 'href') {
      expect(_http.hasMatch(v) || (value['type'] == 'text' && _mailOrTel.hasMatch(v)), isTrue, reason: v);
    } else if (k == 'srcset') {
      for (final part in v.split(', ')) {
        expect(part, matches(_http));
      }
    }
  });
}

/// The article is safe and none of [needles] made it into its JSON.
void _expectClean(Json article, [List<String> needles = const []]) {
  _expectSafeUrls(article);
  final json = jsonEncode(article);
  for (final needle in needles) {
    expect(json, isNot(contains(needle)));
  }
}

bool _hasType(Json article, Set<String> types) =>
    _list(article['blocks']).any((b) => types.contains((b as Map<String, Object?>)['type']));

void main() {
  test('links keep only http(s), mailto and tel, decided after parsing', () {
    const links = [
      '&#1;javascript:alert(1)', ' &#1;&#31;JavaScript:alert(1)', 'java\tscript:alert(1)', 'file:///etc/passwd', //
      'intent://x#Intent;end', 'data:text/html,hi', '&#1;data:text/html,hi', 'web+evil:x', 'vbscript:x',
      'blob:https://example.com/x', 'about:blank',
    ];
    final body = StringBuffer('<p>');
    for (var i = 0; i < links.length; i++) {
      body.write('<a href="${links[i]}">l$i</a> ');
    }
    body.write('<a href="mailto:a@b.c">m</a> <a href="/next">n</a></p>');
    final article = _article(body.toString());
    _expectClean(article, [
      'javascript', 'JavaScript', 'file:', 'intent:', 'data:', 'web+evil', 'vbscript', 'blob:', 'about:', //
    ]);
    final runs = _list((_list(article['blocks'])[1] as Map<String, Object?>)['content']);
    expect(
      [for (final r in runs.cast<Map<String, Object?>>()) ?r['href']],
      ['mailto:a@b.c', 'https://example.com/next'],
    );
  });

  test('a figure links only to an http(s) file', () {
    List<Object?> figure(String href) => _blocks(
      '<div><a href="$href"><span><span><img src="/big.jpg" width="800" height="600"></span></span></a></div>',
    );
    expect(figure('mailto:a@b.png'), [
      {
        'type': 'figure',
        'images': [
          {'src': 'https://example.com/big.jpg', 'alt': '', 'width': 800, 'height': 600},
        ],
      },
    ]);
    expect(figure('/full.png'), [
      {
        'type': 'figure',
        'images': [
          {
            'src': 'https://example.com/big.jpg',
            'alt': '',
            'width': 800,
            'height': 600,
            'href': 'https://example.com/full.png',
          },
        ],
      },
    ]);
  });

  test('a <base> that is not http(s) does not become the base', () {
    final article = _article(
      '<p>Read the <a href="next">next part</a> of the story.</p>',
      head: '<base href="file:///etc/">',
    );
    _expectClean(article, ['file:']);
    expect(jsonEncode(_list(article['blocks'])[1]), contains('"href":"https://example.com/next"'));
  });

  test('social embeds take only http(s) URLs from their attributes and links', () {
    const cases = [
      '<blockquote class="twitter-tweet" cite="javascript:alert(document.domain)"><p>hello tweet</p></blockquote>',
      '<blockquote class="reddit-embed"><p>x</p><a href="file:///etc/passwd">l</a></blockquote>',
      '<blockquote class="twitter-tweet"><p>hello</p><a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;//twitter.com/a/status/1">l</a></blockquote>',
      '<blockquote class="instagram-media" data-instgrm-permalink="&#1;javascript:alert(1)"><p>insta</p></blockquote>',
      '<blockquote class="bluesky-embed" data-bluesky-uri="javascript:alert(1)"><p>sky</p></blockquote>',
      '<blockquote class="fb-post" data-href="vbscript:x"><p>post</p></blockquote>',
    ];
    for (final body in cases) {
      final article = _article(body);
      _expectClean(article, ['javascript', 'file:', 'data:', 'vbscript']);
      expect(_hasType(article, {'embed'}), isFalse, reason: body);
    }
    // A bad attribute falls through to the next candidate.
    final reddit = _blocks(
      '<blockquote class="reddit-embed" cite="javascript:alert(1)"><p>post</p><a href="/r/x/comments/1">l</a></blockquote>',
    );
    expect(reddit[0], containsPair('url', 'https://example.com/r/x/comments/1'));
    expect(reddit[0], containsPair('provider', 'reddit'));
  });

  test('a real tweet blockquote is still a twitter embed', () {
    const body =
        '<blockquote class="twitter-tweet"><p lang="en">Real tweet text</p>&mdash; Jane (@jane) <a href="https://twitter.com/jane/status/123456?ref_src=twsrc">May 1, 2024</a></blockquote>';
    expect(_blocks(body), [
      {
        'type': 'embed',
        'provider': 'twitter',
        'url': 'https://twitter.com/jane/status/123456?ref_src=twsrc',
        'author': 'Jane (@jane)',
        'blocks': [
          {
            'type': 'paragraph',
            'content': [
              {'type': 'text', 'text': 'Real tweet text'},
            ],
          },
        ],
      },
    ]);
  });

  test('<video> and <audio> sources are resolved before provider matching', () {
    const cases = [
      '<video src="javascript://embed.ted.com/talks/x%0aalert(document.domain)"></video>',
      '<audio src="javascript://bandcamp.com/EmbeddedPlayer%0aalert(1)"></audio>',
      '<audio src="file:///etc/passwd#bandcamp.com/EmbeddedPlayer"></audio>',
      '<video><source src="&#1;javascript://fast.wistia.net/embed/iframe/abc%0aalert(1)"></video>',
    ];
    for (final body in cases) {
      final article = _article(body);
      _expectClean(article, ['javascript', 'file:']);
      expect(_hasType(article, {'video', 'audio'}), isFalse, reason: body);
    }
    expect(_blocks('<video src="//player.twitch.tv/?channel=abc"></video>'), [
      {
        'type': 'video',
        'provider': 'twitch',
        'url': 'https://www.twitch.tv/abc',
        'embedUrl': 'https://player.twitch.tv/?channel=abc',
      },
    ]);
    expect(_blocks('<video src="https://cdn.example.com/clip.mp4" poster="javascript:alert(1)"></video>'), [
      {'type': 'video', 'provider': 'file', 'url': 'https://cdn.example.com/clip.mp4'},
    ]);
    expect(_blocks('<audio src="/a.mp3"></audio>'), [
      {'type': 'audio', 'provider': 'file', 'url': 'https://example.com/a.mp3'},
    ]);
  });

  test('a SoundCloud player names an http(s) track page or itself', () {
    const src = 'https://w.soundcloud.com/player/?url=javascript%3Aalert(document.domain)';
    final article = _article('<iframe src="$src"></iframe>');
    _expectClean(article, ['javascript:']);
    expect(_list(article['blocks'])[1], {'type': 'audio', 'provider': 'soundcloud', 'url': src, 'embedUrl': src});
    const ok = 'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/123&amp;color=ff5500';
    expect(_blocks('<iframe src="$ok"></iframe>')[0], containsPair('url', 'https://api.soundcloud.com/tracks/123'));
  });

  test('a lite-vimeo id is digits', () {
    final article = _article('<lite-vimeo videoid="1/../../../@evil?&quot;&gt;&lt;x"></lite-vimeo>');
    _expectClean(article, ['@evil', '<x']);
    expect(_hasType(article, {'video'}), isFalse);
    expect(_blocks('<lite-vimeo videoid="76979871"></lite-vimeo>'), [
      {
        'type': 'video',
        'provider': 'vimeo',
        'url': 'https://vimeo.com/76979871',
        'embedUrl': 'https://player.vimeo.com/video/76979871',
      },
    ]);
  });

  test('userinfo does not borrow a host', () {
    for (final href in ['https://evil.com:x@www.nytimes.com/story', 'https://www.nytimes.com@evil.com/story']) {
      final article = _article('', head: '<link rel="canonical" href="$href">', url: 'https://evil.com/a');
      expect(article['url'], 'https://evil.com/a');
    }
    // A canonical URL on the same site still wins.
    final same = _article(
      '',
      head: '<link rel="canonical" href="https://evil.com/story">',
      url: 'https://evil.com/a?utm_source=x',
    );
    expect(same['url'], 'https://evil.com/story');
    // Userinfo does not make a frame a known embed host.
    expect(
      _blocks('<iframe src="https://datawrapper.de:x@evil.com/chart/" width="600" height="400"></iframe>'),
      isEmpty,
    );
    expect(_blocks('<iframe src="https://datawrapper.dwcdn.net/abc/1/" width="600" height="400"></iframe>'), [
      {'type': 'embed', 'provider': 'datawrapper', 'url': 'https://datawrapper.dwcdn.net/abc/1/'},
    ]);
  });

  test('MathML keeps only MathML elements and attributes', () {
    const body =
        '<p>f <math href="javascript:alert(1)" onclick="alert(2)"><mtext><img src=x onerror=alert(document.domain)><a href="javascript:alert(3)">c</a><iframe srcdoc="&lt;script&gt;alert(4)&lt;/script&gt;"></iframe><style>*{}</style><script>alert(6)</script></mtext><mi xlink:href="javascript:alert(5)" a"b=1 style="color:red">x</mi></math> g</p>';
    final article = _article(body);
    _expectClean(article);
    final math = _list((_list(article['blocks'])[1] as Map<String, Object?>)['content'])[1] as Map<String, Object?>;
    expect(math['mathml'], '<math><mtext>c</mtext><mi>x</mi></math>');
    final mathml = math['mathml'] as String;
    for (final bad in [r'\son\w+=', 'href', '<img', r'<a[\s>]', '<iframe', '<style', '<script', 'javascript']) {
      expect(mathml, isNot(matches(RegExp(bad))));
    }
  });

  test('Wikipedia-style MathML still serializes', () {
    const formula =
        r'<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\displaystyle e^{i\pi }+1=0}" class="mwe-math-element"><semantics><mrow class="MJX-TeXAtom-ORD"><mstyle displaystyle="true" scriptlevel="0"><msup><mi>e</mi><mrow data-mjx-texclass="ORD"><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo stretchy="false">=</mo><mn>0</mn></mstyle></mrow><annotation encoding="application/x-tex">{\displaystyle e^{i\pi }+1=0}</annotation></semantics></math>';
    final paragraph = _blocks('<p>Euler: $formula holds.</p>')[0] as Map<String, Object?>;
    expect(_list(paragraph['content'])[1], {
      'type': 'math',
      'tex': r'e^{i\pi }+1=0',
      'mathml':
          r'<math alttext="{\displaystyle e^{i\pi }+1=0}"><semantics><mrow><mstyle displaystyle="true" scriptlevel="0"><msup><mi>e</mi><mrow data-mjx-texclass="ORD"><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo stretchy="false">=</mo><mn>0</mn></mstyle></mrow></semantics></math>',
      'text': r'e^{i\pi }+1=0',
    });
  });
}
