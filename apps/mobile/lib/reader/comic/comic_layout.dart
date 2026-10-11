import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import '../../data/models/library.dart';

/// What one screen shows: a page on either side of the spine, or a single page
/// filling the whole view ([full]: single-page mode, or a double-page scan).
@immutable
class ComicSpread {
  const ComicSpread({this.left, this.right}) : full = false;
  const ComicSpread.full(int page) : left = page, right = page, full = true;

  final int? left;
  final int? right;
  final bool full;

  int get first => left ?? right!;
  int get last => right ?? left!;
  bool contains(int page) => page >= first && page <= last;

  @override
  bool operator ==(Object other) =>
      other is ComicSpread && other.left == left && other.right == right && other.full == full;

  @override
  int get hashCode => Object.hash(left, right, full);

  @override
  String toString() => full ? '[$left]' : '[${left ?? '_'}|${right ?? '_'}]';
}

/// Single pages on portrait phones; two-page spreads everywhere else.
bool comicTwoUp(Size screen) =>
    !(screen.shortestSide < 600 && screen.height >= screen.width);

/// Spreads per docs/comics.md: the cover alone on the right, then pairs
/// (2–3, 4–5, …); a page wider than tall takes a spread alone and pairing
/// continues after it; a page with no partner stands alone on the left.
List<ComicSpread> computeSpreads(
  int pageCount, {
  required bool twoUp,
  required bool Function(int page) isWide,
}) {
  if (!twoUp) return [for (var i = 0; i < pageCount; i++) ComicSpread.full(i)];
  final spreads = <ComicSpread>[];
  if (pageCount == 0) return spreads;
  spreads.add(isWide(0) ? const ComicSpread.full(0) : const ComicSpread(right: 0));
  var i = 1;
  while (i < pageCount) {
    if (isWide(i)) {
      spreads.add(ComicSpread.full(i));
      i++;
    } else if (i + 1 < pageCount && !isWide(i + 1)) {
      spreads.add(ComicSpread(left: i, right: i + 1));
      i += 2;
    } else {
      spreads.add(ComicSpread(left: i));
      i++;
    }
  }
  return spreads;
}

/// Index of the spread showing [page] (clamped into range).
int spreadIndexOf(List<ComicSpread> spreads, int page) {
  var lo = 0;
  var hi = spreads.length - 1;
  while (lo < hi) {
    final mid = (lo + hi + 1) >> 1;
    if (spreads[mid].first <= page) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/// Assumed shape of a page whose size is not known yet: portrait.
const defaultPageAspect = 2 / 3;

/// A page (or part of a double-page scan) drawn into [rect], from the
/// fraction [source] of its image (0..1 on both axes).
@immutable
class ComicFace {
  const ComicFace(this.page, this.rect, [this.source = const Rect.fromLTWH(0, 0, 1, 1)]);
  final int page;
  final Rect rect;
  final Rect source;
}

/// Where a spread's pages sit inside [box]. In two-up layouts every spread has
/// a face on each side of the spine (a double-page scan split in half) so a
/// flip can turn any of them; [whole] draws an undivided full page.
@immutable
class SpreadGeometry {
  const SpreadGeometry({this.left, this.right, this.whole, required this.spine});
  final ComicFace? left;
  final ComicFace? right;
  final ComicFace? whole;
  final double spine;
}

Rect _contain(double aspect, Rect box, Alignment alignment) {
  var w = box.width;
  var h = w / aspect;
  if (h > box.height) {
    h = box.height;
    w = h * aspect;
  }
  return alignment.inscribe(Size(w, h), box);
}

/// Pages fit (contain) and touch the spine; [aspectOf] is width / height.
SpreadGeometry layoutSpread(
  ComicSpread spread,
  Rect box, {
  required bool twoUp,
  required double Function(int page) aspectOf,
}) {
  final spine = box.center.dx;
  if (spread.full) {
    final rect = _contain(aspectOf(spread.first), box, Alignment.center);
    if (!twoUp) return SpreadGeometry(whole: ComicFace(spread.first, rect), spine: spine);
    final split = ((spine - rect.left) / rect.width).clamp(0.0, 1.0);
    return SpreadGeometry(
      whole: ComicFace(spread.first, rect),
      left: ComicFace(
        spread.first,
        Rect.fromLTRB(rect.left, rect.top, spine, rect.bottom),
        Rect.fromLTRB(0, 0, split, 1),
      ),
      right: ComicFace(
        spread.first,
        Rect.fromLTRB(spine, rect.top, rect.right, rect.bottom),
        Rect.fromLTRB(split, 0, 1, 1),
      ),
      spine: spine,
    );
  }
  final leftBox = Rect.fromLTRB(box.left, box.top, spine, box.bottom);
  final rightBox = Rect.fromLTRB(spine, box.top, box.right, box.bottom);
  final l = spread.left;
  final r = spread.right;
  return SpreadGeometry(
    left: l == null ? null : ComicFace(l, _contain(aspectOf(l), leftBox, Alignment.centerRight)),
    right: r == null ? null : ComicFace(r, _contain(aspectOf(r), rightBox, Alignment.centerLeft)),
    spine: spine,
  );
}

/// The largest box a page is ever drawn into, for decoding at display size.
Size comicDisplayBox(Size view, {required bool twoUp, required bool wide}) =>
    twoUp && !wide ? Size(view.width / 2, view.height) : view;

/// Contract locator (docs/comics.md "Reading position").
ReadingLocator comicLocator(List<String> pages, int page) {
  final count = pages.length;
  final index = page.clamp(0, count - 1);
  return ReadingLocator(
    href: pages[index],
    progression: 0,
    totalProgression: count <= 1 ? 1 : index / (count - 1),
    title: 'Page ${index + 1} of $count',
    engine: 'comic',
    raw: {'page': index, 'pages': count},
  );
}

/// Restores by href first, then `raw.page`; anything else starts at the cover.
int comicPageFromLocator(List<String> pages, ReadingLocator? locator) {
  if (locator == null || pages.isEmpty) return 0;
  final byHref = pages.indexOf(locator.href);
  if (byHref >= 0) return byHref;
  final raw = locator.raw?['page'];
  if (locator.engine == 'comic' && raw is num) {
    return raw.toInt().clamp(0, pages.length - 1);
  }
  return 0;
}
