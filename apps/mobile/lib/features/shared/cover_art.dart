import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';

/// Generated editorial cover: a typographic plate with a deterministic
/// geometric mark per book. Used when the catalog has no cover image, and as
/// the placeholder while a real cover loads.
class CoverArt extends StatelessWidget {
  const CoverArt({super.key, required this.book, this.imageUri, this.width = 96});

  final Book book;
  final Uri? imageUri;
  final double width;

  static const double ratio = 2 / 3;

  @override
  Widget build(BuildContext context) {
    final height = width / ratio;
    final plate = _Plate(book: book, width: width, height: height);
    Widget child = plate;
    if (imageUri != null) {
      child = Image.network(
        imageUri.toString(),
        width: width,
        height: height,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.medium,
        errorBuilder: (_, _, _) => plate,
        frameBuilder: (context, img, frame, sync) => frame == null ? plate : img,
      );
    }
    return Semantics(
      label: 'Cover of ${book.title}',
      image: true,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radii.sm),
        child: SizedBox(width: width, height: height, child: child),
      ),
    );
  }
}

class _Plate extends StatelessWidget {
  const _Plate({required this.book, required this.width, required this.height});
  final Book book;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final seed = book.id.codeUnits.fold<int>(17, (a, c) => (a * 31 + c) & 0x7fffffff);
    final accent = const [Palette.blue, Palette.purple, Palette.green, Palette.orange, Palette.cyan, Palette.pink][seed % 6];
    final scale = width / 96;
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: Palette.panel,
        border: Border.fromBorderSide(BorderSide(color: Palette.border)),
        borderRadius: BorderRadius.all(Radii.sm),
      ),
      child: CustomPaint(
        painter: _MarkPainter(seed: seed, accent: accent),
        child: Padding(
          padding: EdgeInsets.all(10 * scale),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Spacer(),
              Text(
                book.title,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontFamily: Fonts.serif,
                  fontSize: 12.5 * scale,
                  height: 1.15,
                  fontWeight: FontWeight.w500,
                  color: Palette.fg,
                  letterSpacing: -0.2,
                ),
              ),
              SizedBox(height: 5 * scale),
              Text(
                book.author.toUpperCase(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontFamily: Fonts.sans,
                  fontSize: 7.5 * scale,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.8,
                  color: Palette.muted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MarkPainter extends CustomPainter {
  _MarkPainter({required this.seed, required this.accent});
  final int seed;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    final variant = (seed ~/ 7) % 4;
    final paint = Paint()
      ..color = accent
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.018
      ..strokeCap = StrokeCap.round;
    final inset = size.width * 0.11;
    final top = size.height * 0.10;
    final w = size.width - inset * 2;
    switch (variant) {
      case 0:
        // Horizontal rules, descending lengths.
        for (var i = 0; i < 4; i++) {
          final y = top + i * size.height * 0.045;
          canvas.drawLine(Offset(inset, y), Offset(inset + w * (1 - i * 0.22), y), paint);
        }
      case 1:
        // A circle and a tangent line.
        final r = size.width * 0.13;
        canvas.drawCircle(Offset(inset + r, top + r), r, paint);
        canvas.drawLine(Offset(inset + r * 2 + inset * 0.6, top + r * 2),
            Offset(inset + w, top + r * 2), paint);
      case 2:
        // Diagonal hatch.
        for (var i = 0; i < 5; i++) {
          final x = inset + i * size.width * 0.075;
          canvas.drawLine(Offset(x, top + size.height * 0.16), Offset(x + size.width * 0.16, top), paint);
        }
      default:
        // A square and a dot.
        final s = size.width * 0.22;
        canvas.drawRect(Rect.fromLTWH(inset, top, s, s), paint);
        canvas.drawCircle(Offset(inset + s + inset * 0.9, top + s / 2), size.width * 0.03,
            paint..style = PaintingStyle.fill);
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.seed != seed || old.accent != accent;
}
