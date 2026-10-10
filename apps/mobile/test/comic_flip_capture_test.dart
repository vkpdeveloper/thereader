import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/features/comic/comic_reader_view.dart';
import 'package:thereader/reader/comic/comic_page_store.dart';

/// Writes flip frames to /tmp/comic-proof/mobile-reader/ for a human (or an
/// agent) to look at. Run with COMIC_CAPTURE=1; skipped otherwise.
final _capture = Platform.environment['COMIC_CAPTURE'] == '1';
const _out = '/tmp/comic-proof/mobile-reader';

const _tints = [
  Color(0xFFE85D4A),
  Color(0xFF3F7CC4),
  Color(0xFFF2B33D),
  Color(0xFF4FA36B),
  Color(0xFF8E5CC2),
  Color(0xFF1DA9B0),
];

/// A comic-ish page: paper, inked panels, flat colour, a speech balloon and
/// a big page number so the leaf's front and back are easy to tell apart.
Future<ui.Image> _page(int index, {bool wide = false}) async {
  final w = wide ? 2000.0 : 1000.0;
  const h = 1500.0;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = const Color(0xFFF4EEDF));
  final ink = Paint()
    ..color = const Color(0xFF111111)
    ..style = PaintingStyle.stroke
    ..strokeWidth = 8;
  final r = math.Random(index * 31 + 7);
  const m = 50.0;
  final rows = wide ? 2 : 3;
  final rowH = (h - m * (rows + 1)) / rows;
  for (var row = 0; row < rows; row++) {
    final cols = 1 + r.nextInt(wide ? 3 : 2);
    final colW = (w - m * (cols + 1)) / cols;
    for (var col = 0; col < cols; col++) {
      final rect = Rect.fromLTWH(m + col * (colW + m), m + row * (rowH + m), colW, rowH);
      final tint = _tints[(index + row * 2 + col) % _tints.length];
      canvas.drawRect(
        rect,
        Paint()
          ..shader = ui.Gradient.linear(rect.topLeft, rect.bottomRight, [
            tint.withValues(alpha: 0.85),
            Color.lerp(tint, Colors.white, 0.55)!,
          ]),
      );
      // A horizon and a sun so panels read as pictures.
      canvas.drawCircle(
        rect.topLeft + Offset(rect.width * (0.2 + r.nextDouble() * 0.6), rect.height * 0.35),
        rect.shortestSide * 0.14,
        Paint()..color = const Color(0xFFFFF4C2),
      );
      canvas.drawRect(
        Rect.fromLTRB(rect.left, rect.top + rect.height * 0.68, rect.right, rect.bottom),
        Paint()..color = const Color(0x55111111),
      );
      canvas.drawRect(rect, ink);
    }
  }
  // Balloon with the page number.
  final balloon = Rect.fromCenter(center: Offset(w / 2, m + rowH * 0.42), width: 420, height: 230);
  canvas.drawOval(balloon, Paint()..color = Colors.white);
  canvas.drawOval(balloon, ink);
  final label = TextPainter(
    text: TextSpan(
      text: wide ? 'SPREAD ${index + 1}' : 'PAGE ${index + 1}',
      style: const TextStyle(
        fontFamily: 'Inter',
        fontSize: 64,
        fontWeight: FontWeight.w800,
        color: Color(0xFF111111),
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  label.paint(canvas, balloon.center - Offset(label.width / 2, label.height / 2));
  final picture = recorder.endRecording();
  return picture.toImage(w.round(), h.round());
}

void main() {
  testWidgets('flip frames', (tester) async {
    await tester.runAsync(() async {
      final font = FontLoader('Inter')
        ..addFont(File('assets/fonts/Inter.ttf').readAsBytes().then(ByteData.sublistView));
      await font.load();
      await Directory(_out).create(recursive: true);
    });
    const count = 7;
    final images = <int, ui.Image>{};
    await tester.runAsync(() async {
      for (var i = 0; i < count; i++) {
        images[i] = await _page(i, wide: i == 5);
      }
    });
    final store = ComicPageStore(
      pageCount: count,
      read: (p) async => Uint8List.fromList([p]),
      decode: (bytes, target) async {
        final image = images[bytes[0]]!;
        final size = Size(image.width.toDouble(), image.height.toDouble());
        target(size);
        return DecodedComicPage(size, image.clone());
      },
    );
    // Every page's size known up front, so spreads are final in every frame.
    store.request(List.generate(count, (i) => i), keep: const {}, target: (_, s) => s / 4);
    await tester.pump();
    final controller = ComicViewController();
    final boundary = GlobalKey();

    Future<void> shoot(String name, Size screen, {required int from, required double p}) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = screen;
      await tester.pumpWidget(
        MaterialApp(
          home: RepaintBoundary(
            key: boundary,
            child: ComicReaderView(store: store, controller: controller),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      controller.debugHoldFlip(from: from, progress: p);
      await tester.pump();
      await tester.pump();
      await tester.runAsync(() async {
        final render = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await render.toImage(pixelRatio: 2);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$_out/$name.png').writeAsBytes(png!.buffer.asUint8List());
      });
    }

    const phone = Size(390, 844);
    const phoneLandscape = Size(844, 390);
    const tablet = Size(1180, 820);
    for (final p in [0.0, 0.25, 0.5, 0.75]) {
      await shoot('portrait-${(p * 100).round()}', phone, from: 1, p: p);
    }
    for (final p in [0.0, 0.25, 0.45, 0.55, 0.75]) {
      await shoot('landscape-${(p * 100).round()}', phoneLandscape, from: 1, p: p);
    }
    for (final p in [0.0, 0.3, 0.5, 0.7]) {
      await shoot('tablet-${(p * 100).round()}', tablet, from: 1, p: p);
    }
    // Into and out of the double-page scan (page 6), and the cover turning.
    await shoot('tablet-wide-60', tablet, from: 2, p: 0.6);
    await shoot('tablet-from-wide-40', tablet, from: 3, p: 0.4);
    await shoot('tablet-cover-35', tablet, from: 0, p: 0.35);
    await tester.pumpWidget(const SizedBox());
    store.dispose();
    tester.view.reset();
  }, skip: !_capture);
}
