import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/reader/comic/comic_layout.dart';

String show(List<ComicSpread> spreads) => spreads.join(' ');

void main() {
  group('spreads', () {
    bool none(int _) => false;

    test('single-page mode shows every page alone', () {
      expect(show(computeSpreads(3, twoUp: false, isWide: none)), '[0] [1] [2]');
    });

    test('cover alone on the right, then pairs, trailing page on the left', () {
      expect(show(computeSpreads(6, twoUp: true, isWide: none)), '[_|0] [1|2] [3|4] [5|_]');
      expect(show(computeSpreads(5, twoUp: true, isWide: none)), '[_|0] [1|2] [3|4]');
      expect(show(computeSpreads(1, twoUp: true, isWide: none)), '[_|0]');
      expect(computeSpreads(0, twoUp: true, isWide: none), isEmpty);
    });

    test('a wide page takes a spread alone and pairing continues after it', () {
      expect(
        show(computeSpreads(8, twoUp: true, isWide: (p) => p == 3)),
        '[_|0] [1|2] [3] [4|5] [6|7]',
      );
      // Its would-be partner stands alone on the left.
      expect(
        show(computeSpreads(6, twoUp: true, isWide: (p) => p == 2)),
        '[_|0] [1|_] [2] [3|4] [5|_]',
      );
      expect(show(computeSpreads(3, twoUp: true, isWide: (p) => p == 0)), '[0] [1|2]');
      // Wide pages don't change single-page mode.
      expect(show(computeSpreads(2, twoUp: false, isWide: (_) => true)), '[0] [1]');
    });

    test('page to spread mapping, and back across an orientation change', () {
      final landscape = computeSpreads(7, twoUp: true, isWide: (p) => p == 4);
      final portrait = computeSpreads(7, twoUp: false, isWide: (p) => p == 4);
      expect(show(landscape), '[_|0] [1|2] [3|_] [4] [5|6]');
      expect([for (var p = 0; p < 7; p++) spreadIndexOf(landscape, p)], [0, 1, 1, 2, 3, 4, 4]);
      // Page 6 in portrait → landscape spread [5|6] → back to its first page.
      final spread = landscape[spreadIndexOf(landscape, 6)];
      expect(spread, const ComicSpread(left: 5, right: 6));
      expect(spreadIndexOf(portrait, spread.first), 5);
      expect(spreadIndexOf(landscape, 99), landscape.length - 1);
      expect(spreadIndexOf(landscape, -3), 0);
    });

    test('two-up everywhere but portrait phones', () {
      expect(comicTwoUp(const Size(390, 844)), isFalse);
      expect(comicTwoUp(const Size(844, 390)), isTrue);
      expect(comicTwoUp(const Size(820, 1180)), isTrue);
      expect(comicTwoUp(const Size(1180, 820)), isTrue);
    });
  });

  group('geometry', () {
    const box = Rect.fromLTWH(0, 0, 1000, 600);
    double portrait(int _) => 2 / 3;

    test('pages fit their half and touch the spine', () {
      final g = layoutSpread(const ComicSpread(left: 1, right: 2), box, twoUp: true, aspectOf: portrait);
      expect(g.spine, 500);
      expect(g.left!.rect, const Rect.fromLTWH(100, 0, 400, 600));
      expect(g.right!.rect, const Rect.fromLTWH(500, 0, 400, 600));
      final cover = layoutSpread(const ComicSpread(right: 0), box, twoUp: true, aspectOf: portrait);
      expect(cover.left, isNull);
      expect(cover.right!.rect.left, 500);
    });

    test('a double-page scan is centred whole and split at the spine for flips', () {
      final g = layoutSpread(const ComicSpread.full(3), box, twoUp: true, aspectOf: (_) => 2.0);
      expect(g.whole!.rect, const Rect.fromLTWH(0, 250, 1000, 500).translate(0, -200));
      expect(g.left!.rect.right, 500);
      expect(g.left!.source, const Rect.fromLTRB(0, 0, 0.5, 1));
      expect(g.right!.source, const Rect.fromLTRB(0.5, 0, 1, 1));
    });

    test('single-page mode centres the page', () {
      final g = layoutSpread(
        const ComicSpread.full(0),
        const Rect.fromLTWH(0, 0, 400, 800),
        twoUp: false,
        aspectOf: portrait,
      );
      expect(g.whole!.rect, const Rect.fromLTWH(0, 100, 400, 600));
      expect(g.left, isNull);
    });

    test('display boxes for decoding', () {
      const view = Size(1000, 600);
      expect(comicDisplayBox(view, twoUp: true, wide: false), const Size(500, 600));
      expect(comicDisplayBox(view, twoUp: true, wide: true), view);
      expect(comicDisplayBox(view, twoUp: false, wide: false), view);
    });
  });

  group('locator', () {
    const pages = [
      'Comic/Cover.webp',
      'Comic/extras/001.jpg',
      'Comic/page2.JPG',
      'Comic/page02b.png',
      'Comic/page10.jpg',
    ];

    test('matches the contract example', () {
      final loc = comicLocator(pages, 4);
      expect(loc.toJson(), {
        'href': 'Comic/page10.jpg',
        'progression': 0.0,
        'totalProgression': 1.0,
        'title': 'Page 5 of 5',
        'engine': 'comic',
        'raw': {'page': 4, 'pages': 5},
      });
      expect(comicLocator(pages, 1).totalProgression, 0.25);
      expect(comicLocator(const ['only.jpg'], 0).totalProgression, 1);
    });

    test('restores by href first, then raw.page', () {
      expect(comicPageFromLocator(pages, comicLocator(pages, 3)), 3);
      // The href wins over a stale raw index.
      expect(
        comicPageFromLocator(
          pages,
          const ReadingLocator(
            href: 'Comic/page2.JPG',
            progression: 0,
            engine: 'comic',
            raw: {'page': 0, 'pages': 5},
          ),
        ),
        2,
      );
      expect(
        comicPageFromLocator(
          pages,
          const ReadingLocator(href: 'gone.jpg', progression: 0, engine: 'comic', raw: {'page': 9}),
        ),
        4,
      );
      expect(comicPageFromLocator(pages, null), 0);
      expect(
        comicPageFromLocator(pages, const ReadingLocator(href: 'ch1.xhtml', progression: .5)),
        0,
      );
      // Round-trips through JSON as sync stores it.
      final json = comicLocator(pages, 2).toJson();
      expect(comicPageFromLocator(pages, ReadingLocator.fromJson(json)), 2);
    });
  });
}
