import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/category.dart';
import '../articles/article_media.dart';
import '../shared/cover_art.dart';
import 'category_items.dart';

/// A category on the Library home: a small bookcase holding its three newest
/// items, with the name and count beneath. Pressing (or hovering) blooms the
/// books open like petals; releasing lets them settle back. Tap opens it.
class CategoryShelf extends StatefulWidget {
  const CategoryShelf({
    super.key,
    required this.category,
    required this.items,
    required this.onOpen,
    this.width = CategoryShelf.defaultWidth,
  });

  final Category category;

  /// Every member found on this device, newest first. The first three stand
  /// on the shelf; the length is the count.
  final List<FiledItem> items;
  final VoidCallback onOpen;
  final double width;

  static const double defaultWidth = 156;

  @override
  State<CategoryShelf> createState() => _CategoryShelfState();
}

class _CategoryShelfState extends State<CategoryShelf> with SingleTickerProviderStateMixin {
  /// Unbounded: the opening spring overshoots a touch past fully open.
  late final AnimationController _bloom = AnimationController.unbounded(vsync: this);
  bool _pressed = false;
  bool _holding = false;

  /// Recognizers report a cancel while the tree is torn down; ignore it.
  bool _active = true;

  /// Under-damped so the petals spring open with a small overshoot; the
  /// return is nearly critically damped so the books settle without a wobble.
  static const _openSpring = SpringDescription(mass: 1, stiffness: 300, damping: 19);
  static const _closeSpring = SpringDescription(mass: 1, stiffness: 340, damping: 32);

  bool get _reduced => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  void _open() {
    if (_pressed) return;
    setState(() => _pressed = true);
    if (_reduced) return;
    _bloom.animateWith(SpringSimulation(_openSpring, _bloom.value, 1, _bloom.velocity));
  }

  void _close() {
    if (!_pressed || !_active) return;
    setState(() => _pressed = false);
    if (_reduced) {
      _bloom.value = 0;
      return;
    }
    _bloom.animateWith(SpringSimulation(_closeSpring, _bloom.value, 0, _bloom.velocity));
  }

  /// A tap is cancelled when the long-press wins the arena; that press is
  /// still being held, so wait a microtask to see whether it became a hold.
  void _tapCancelled() => scheduleMicrotask(() {
    if (mounted && !_holding) _close();
  });

  @override
  void deactivate() {
    _active = false;
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    _active = true;
  }

  @override
  void dispose() {
    _bloom.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final c = widget.category;
    final count = widget.items.length;
    return Semantics(
      button: true,
      label: '${c.name}, ${itemCount(count)}',
      hint: 'Opens the category',
      excludeSemantics: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => _open(),
        onExit: (_) => _close(),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => _open(),
          onTapUp: (_) => _close(),
          onTapCancel: _tapCancelled,
          onTap: widget.onOpen,
          onLongPressStart: (_) {
            _holding = true;
            HapticFeedback.selectionClick();
            _open();
          },
          onLongPressEnd: (_) {
            _holding = false;
            _close();
          },
          onLongPressCancel: () {
            _holding = false;
            _close();
          },
          child: SizedBox(
            width: widget.width,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AnimatedBuilder(
                  animation: _bloom,
                  builder: (context, _) => ShelfCase(
                    color: c.color.hue,
                    items: widget.items.take(3).toList(),
                    width: widget.width,
                    bloom: _bloom.value,
                    pressed: _pressed,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(color: c.color.hue, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(c.name, style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Padding(
                  padding: const EdgeInsets.only(left: 14),
                  child: Text(
                    count == 0 ? 'Empty shelf' : itemCount(count),
                    style: text.labelSmall?.copyWith(letterSpacing: 0, color: colors.muted),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One book's pose: horizontal place on the shelf, its resting lean and how
/// far it opens. Angles are in degrees; positive leans right.
class _Pose {
  const _Pose(this.x, this.rest, this.open, this.lift, [this.scale = 1]);
  final double x;
  final double rest;
  final double open;
  final double lift;
  final double scale;
}

/// Poses at the reference width, back to front: the newest item stands in
/// the middle and is painted last so it is in front.
List<_Pose> _poses(int n) => switch (n) {
  1 => const [_Pose(0, 0, -4, 8, 1.05)],
  2 => const [_Pose(-15, -2, -13, 4), _Pose(15, 2, 13, 4, 1.02)],
  _ => const [_Pose(-26, -2.5, -21, 2), _Pose(26, 2.5, 21, 2), _Pose(0, 0, 0, 8, 1.05)],
};

/// The bookcase itself: a panel washed with the category colour, a glowing
/// shelf, and up to three items standing on it.
///
/// [bloom] runs from 0 (at rest) to 1 (open). Every book rotates about one
/// shared pivot just below the middle of the shelf, so they fan out from a
/// common base like petals, lifting a little; none leaves the case. An empty
/// category shows three dashed outlines: an intentionally empty shelf.
class ShelfCase extends StatelessWidget {
  const ShelfCase({
    super.key,
    required this.color,
    required this.items,
    this.width = CategoryShelf.defaultWidth,
    this.bloom = 0,
    this.pressed = false,
  });

  final Color color;

  /// Up to three items, newest first.
  final List<FiledItem> items;
  final double width;
  final double bloom;

  /// Shown as a brighter outline; the only feedback under reduced motion.
  final bool pressed;

  static const double _refWidth = CategoryShelf.defaultWidth;
  static const double _refHeight = 120;

  static double heightFor(double width) => width * _refHeight / _refWidth;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final k = width / _refWidth;
    final height = heightFor(width);
    final bookWidth = 46 * k;
    final bookHeight = bookWidth / CoverArt.ratio;
    final shelfTop = height - 24 * k;
    final pivotDrop = 10 * k;
    final b = bloom;
    final glow = b.clamp(0.0, 1.0);
    final empty = items.isEmpty;
    final poses = _poses(empty ? 3 : items.length);
    // Back to front: index 0 is the newest and stands in the middle (last pose).
    final order = empty
        ? [null, null, null]
        : switch (items.length) {
            1 => [items[0]],
            2 => [items[1], items[0]],
            _ => [items[1], items[2], items[0]],
          };

    return SizedBox(
      width: width,
      height: height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.panel,
          borderRadius: const BorderRadius.all(Radii.lg),
          border: Border.all(
            color: pressed ? Color.lerp(colors.border, color, 0.45)! : colors.border,
          ),
        ),
        child: ClipRRect(
          borderRadius: const BorderRadius.all(Radii.lg),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              // Colour wash rising from the shelf; it warms as the books open.
              Positioned.fill(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.bottomCenter,
                      end: Alignment.topCenter,
                      colors: [
                        color.withValues(alpha: 0.13 + 0.07 * glow),
                        color.withValues(alpha: 0.03),
                        color.withValues(alpha: 0),
                      ],
                      stops: const [0, 0.55, 1],
                    ),
                  ),
                ),
              ),
              for (var i = 0; i < poses.length; i++)
                Positioned(
                  left: width / 2 - bookWidth / 2,
                  top: shelfTop - bookHeight,
                  width: bookWidth,
                  height: bookHeight,
                  child: Transform(
                    // Origin is the shared pivot, below the book's foot.
                    origin: Offset(bookWidth / 2, bookHeight + pivotDrop),
                    transform: Matrix4.identity()
                      ..rotateZ(lerpDouble(poses[i].rest, poses[i].open, b)! * math.pi / 180)
                      ..translateByDouble(poses[i].x * k, -poses[i].lift * k * b, 0, 1)
                      ..scaleByDouble(
                        lerpDouble(1, poses[i].scale, b)!,
                        lerpDouble(1, poses[i].scale, b)!,
                        1,
                        1,
                      ),
                    child: order[i] == null
                        ? _EmptySlot(color: color)
                        : _ShelfBook(item: order[i]!, width: bookWidth),
                  ),
                ),
              // The shelf board, with a soft glow in the category colour.
              Positioned(
                left: 12 * k,
                right: 12 * k,
                top: shelfTop,
                height: 3 * k,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.75),
                    borderRadius: BorderRadius.circular(1.5 * k),
                    boxShadow: [
                      BoxShadow(
                        color: color.withValues(alpha: 0.22 + 0.2 * glow),
                        blurRadius: 14 * k,
                        offset: Offset(0, 3 * k),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A single item as it stands on a shelf: a book's cover, or an article
/// drawn as a slim plate (its lead image, else its title).
class _ShelfBook extends StatelessWidget {
  const _ShelfBook({required this.item, required this.width});
  final FiledItem item;
  final double width;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final height = width / CoverArt.ratio;
    final Widget face = switch (item) {
      FiledBook(:final entry) => CoverArt(
        book: entry.book,
        width: width,
        imageUri: coverUriFor(AppScope.of(context), entry),
      ),
      FiledArticle(:final summary) => ClipRRect(
        borderRadius: const BorderRadius.all(Radii.sm),
        child: SizedBox(
          width: width,
          height: height,
          child: summary.leadImage != null
              ? NetworkPicture(src: summary.leadImage!, width: width, height: height, decodeWidth: width * 2)
              : _ArticlePlate(title: summary.title, site: summary.site, width: width),
        ),
      ),
    };
    return DecoratedBox(
      position: DecorationPosition.foreground,
      decoration: BoxDecoration(
        borderRadius: const BorderRadius.all(Radii.sm),
        border: Border.all(color: Colors.white.withValues(alpha: 0.07), width: 0.5),
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: const BorderRadius.all(Radii.sm),
          color: colors.panel,
          boxShadow: const [BoxShadow(color: Color(0xB3000000), blurRadius: 8, offset: Offset(0, 3))],
        ),
        child: face,
      ),
    );
  }
}

class _ArticlePlate extends StatelessWidget {
  const _ArticlePlate({required this.title, required this.site, required this.width});
  final String title;
  final String site;
  final double width;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final scale = width / 96;
    return ColoredBox(
      color: colors.element,
      child: Padding(
        padding: EdgeInsets.all(10 * scale),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(width: 18 * scale, height: 2 * scale, color: colors.muted),
            const Spacer(),
            Text(
              title,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: Fonts.serif,
                fontSize: 12.5 * scale,
                height: 1.15,
                fontWeight: FontWeight.w500,
                color: colors.fg,
              ),
            ),
            SizedBox(height: 5 * scale),
            Text(
              site.toUpperCase(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: Fonts.sans,
                fontSize: 7.5 * scale,
                fontWeight: FontWeight.w500,
                letterSpacing: 0.8,
                color: colors.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Dashed outline of a book that is not there yet.
class _EmptySlot extends StatelessWidget {
  const _EmptySlot({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) => CustomPaint(painter: _DashedSlotPainter(color.withValues(alpha: 0.38)));
}

class _DashedSlotPainter extends CustomPainter {
  _DashedSlotPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius(Offset.zero & size, Radii.sm).deflate(0.5);
    canvas.drawRRect(rrect, Paint()..color = color.withValues(alpha: 0.05));
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final dash = size.width / 10;
    for (final metric in (Path()..addRRect(rrect)).computeMetrics()) {
      for (var d = 0.0; d < metric.length; d += dash * 1.8) {
        canvas.drawPath(metric.extractPath(d, d + dash), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DashedSlotPainter old) => old.color != color;
}
