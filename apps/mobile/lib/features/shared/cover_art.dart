import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_svg/flutter_svg.dart';
import '../../data/covers/cover_cache.dart';
import '../../data/covers/cover_validation.dart';
import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../../core/theme/app_colors.dart';
import '../../data/models/book.dart';

/// Real embedded artwork, persisted for offline reading. Generated plates are
/// reserved for publications with no cover; network failures remain explicit.
class CoverArt extends StatefulWidget {
  const CoverArt({
    super.key,
    required this.book,
    this.imageUri,
    this.width = 96,
  });
  final Book book;
  final Uri? imageUri;
  final double width;

  /// Frame is 3:4, the median of real EPUB covers (~0.76; range ~0.63–0.82).
  /// Artwork is cover-fitted and centre-cropped, so no ratio leaves bands.
  static const double ratio = 3 / 4;
  @override
  State<CoverArt> createState() => _CoverArtState();
}

class _CoverArtState extends State<CoverArt> {
  late Future<Uint8List?> _cover;
  Timer? _retry;
  bool _rejected = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(CoverArt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.book.sha256 != widget.book.sha256 ||
        oldWidget.imageUri != widget.imageUri) {
      _load();
    }
  }

  void _load() {
    _retry?.cancel();
    _rejected = false;
    final sha = widget.book.sha256;
    final uri = widget.imageUri;
    final request = CoverCache.shared.then((cache) => cache.load(sha, uri));
    _cover = request;
    request.then(
      (_) {},
      onError: (Object _) {
        if (!mounted || !identical(_cover, request)) return;
        _retry = Timer(const Duration(seconds: 31), () {
          if (mounted) setState(_load);
        });
      },
    );
  }

  @override
  void dispose() {
    _retry?.cancel();
    super.dispose();
  }

  Widget _decodeError() {
    if (!_rejected && widget.imageUri != null) {
      _rejected = true;
      final sha = widget.book.sha256;
      final uri = widget.imageUri!;
      unawaited(CoverCache.shared.then((cache) => cache.reject(sha, uri)));
      _retry?.cancel();
      _retry = Timer(const Duration(seconds: 31), () {
        if (mounted) setState(_load);
      });
    }
    return _status(failed: true);
  }

  Widget _status({bool failed = false}) => ColoredBox(
    color: context.colors.panel,
    child: Center(
      child: Icon(
        failed ? Icons.image_not_supported_outlined : Icons.image_outlined,
        size: (widget.width * .23).clamp(16, 40),
        color: context.colors.muted,
        semanticLabel: failed
            ? 'Cover unavailable. Retrying when connected.'
            : 'Loading cover',
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final width = widget.width;
    final height = width / CoverArt.ratio;
    return Semantics(
      label: 'Cover of ${widget.book.title}',
      image: true,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radii.sm),
        child: SizedBox(
          width: width,
          height: height,
          child: ColoredBox(
            color: context.colors.panel,
            child: FutureBuilder<Uint8List?>(
              future: _cover,
              builder: (context, snapshot) {
                if (snapshot.hasError) return _status(failed: true);
                if (snapshot.connectionState != ConnectionState.done) {
                  return _status();
                }
                final bytes = snapshot.data;
                if (bytes == null) {
                  return _Plate(
                    book: widget.book,
                    width: width,
                    height: height,
                  );
                }
                if (isSvgCover(bytes)) {
                  return SvgPicture.memory(
                    bytes,
                    width: width,
                    height: height,
                    fit: BoxFit.cover,
                    errorBuilder: (_, _, _) => _decodeError(),
                  );
                }
                // Decode into a square of the frame's long side: any cover
                // between 3:4 and square keeps enough pixels to fill the
                // frame after cropping, without decoding the full original.
                final side = (height * MediaQuery.devicePixelRatioOf(context))
                    .round()
                    .clamp(1, 1536);
                return Image(
                  image: ResizeImage(
                    MemoryImage(bytes),
                    width: side,
                    height: side,
                    policy: ResizeImagePolicy.fit,
                  ),
                  width: width,
                  height: height,
                  fit: BoxFit.cover,
                  alignment: Alignment.center,
                  filterQuality: FilterQuality.medium,
                  errorBuilder: (_, _, _) => _decodeError(),
                );
              },
            ),
          ),
        ),
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
    final colors = context.colors;
    final seed = book.id.codeUnits.fold<int>(
      17,
      (a, c) => (a * 31 + c) & 0x7fffffff,
    );
    final accent = [
      colors.blue,
      colors.purple,
      colors.green,
      colors.orange,
      colors.cyan,
      colors.pink,
    ][seed % 6];
    final scale = width / 96;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: context.colors.panel,
        border: Border.fromBorderSide(BorderSide(color: colors.border)),
        borderRadius: const BorderRadius.all(Radii.sm),
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
                  color: colors.fg,
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
                  color: context.colors.muted,
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
          canvas.drawLine(
            Offset(inset, y),
            Offset(inset + w * (1 - i * 0.22), y),
            paint,
          );
        }
      case 1:
        // A circle and a tangent line.
        final r = size.width * 0.13;
        canvas.drawCircle(Offset(inset + r, top + r), r, paint);
        canvas.drawLine(
          Offset(inset + r * 2 + inset * 0.6, top + r * 2),
          Offset(inset + w, top + r * 2),
          paint,
        );
      case 2:
        // Diagonal hatch.
        for (var i = 0; i < 5; i++) {
          final x = inset + i * size.width * 0.075;
          canvas.drawLine(
            Offset(x, top + size.height * 0.16),
            Offset(x + size.width * 0.16, top),
            paint,
          );
        }
      default:
        // A square and a dot.
        final s = size.width * 0.22;
        canvas.drawRect(Rect.fromLTWH(inset, top, s, s), paint);
        canvas.drawCircle(
          Offset(inset + s + inset * 0.9, top + s / 2),
          size.width * 0.03,
          paint..style = PaintingStyle.fill,
        );
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) =>
      old.seed != seed || old.accent != accent;
}
