import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/features/comic/comic_reader_view.dart';
import 'package:thereader/reader/comic/comic_page_store.dart';

/// Writes flip frames to /tmp/comic-proof/mobile-reader-polish/ for a human
/// (or an agent) to look at: one full frame per step and a contact strip per
/// transition. Run with COMIC_CAPTURE=1; skipped otherwise.
final _capture = Platform.environment['COMIC_CAPTURE'] == '1';
const _out = '/tmp/comic-proof/mobile-reader-polish';

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

/// Pages 6, 7 and 10 are double-page scans, so the spreads are
/// `[_|0] [1|2] [3|4] [5|_] 6 7 [8|9] 10 [11|_]`: every one-sided case.
const _wide = {6, 7, 10};
const _count = 12;

/// Spread transitions (from spread index) and what they show. A flip at
/// progress p draws the same frame turning either way, so each strip read
/// right to left is the backward turn.
const _spreadTurns = {
  0: 'cover-to-2-3',
  1: 'pair-to-pair',
  2: 'pair-to-page-alone',
  3: 'page-alone-to-wide',
  4: 'wide-to-wide',
  5: 'wide-to-pair',
  6: 'pair-to-wide',
  7: 'wide-to-last-alone-left',
};

/// Single-page transitions on a portrait phone (from page index).
const _singleTurns = {
  1: 'single-page-to-page',
  5: 'single-page-to-wide',
  6: 'single-wide-to-wide',
  7: 'single-wide-to-page',
};

const _steps = [0.1, 0.3, 0.5, 0.7, 0.9];

void main() {
  testWidgets('flip frames', (tester) async {
    await tester.runAsync(() async {
      final font = FontLoader('Inter')
        ..addFont(File('assets/fonts/Inter.ttf').readAsBytes().then(ByteData.sublistView));
      await font.load();
      await Directory(_out).create(recursive: true);
    });
    final images = <int, ui.Image>{};
    await tester.runAsync(() async {
      for (var i = 0; i < _count; i++) {
        images[i] = await _page(i, wide: _wide.contains(i));
      }
    });
    final store = ComicPageStore(
      pageCount: _count,
      read: (p) async => Uint8List.fromList([p]),
      decode: (bytes, target) async {
        final image = images[bytes[0]]!;
        final size = Size(image.width.toDouble(), image.height.toDouble());
        target(size);
        return DecodedComicPage(size, image.clone());
      },
    );
    // Every page's size known up front, so spreads are final in every frame.
    store.request(List.generate(_count, (i) => i), keep: const {}, target: (_, s) => s / 4);
    await tester.pump();
    final controller = ComicViewController();
    final boundary = GlobalKey();

    Future<ui.Image> shoot(Size screen, {required int from, required double p}) async {
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
      late ui.Image image;
      await tester.runAsync(() async {
        final render = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        image = await render.toImage();
      });
      return image;
    }

    Future<void> write(String name, ui.Image image) => tester.runAsync(() async {
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$_out/$name.png').writeAsBytes(png!.buffer.asUint8List());
    });

    /// Frames side by side at half size, each labelled with its progress.
    Future<void> strip(String name, List<ui.Image> frames) async {
      const gap = 12.0;
      const scale = 0.5;
      final w = frames.first.width * scale;
      final h = frames.first.height * scale;
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      final size = Size(frames.length * (w + gap) + gap, h + 2 * gap + 28);
      canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF333333));
      for (var i = 0; i < frames.length; i++) {
        final dst = Rect.fromLTWH(gap + i * (w + gap), gap, w, h);
        final src = Rect.fromLTWH(0, 0, frames[i].width.toDouble(), frames[i].height.toDouble());
        canvas.drawImageRect(frames[i], src, dst, Paint()..filterQuality = FilterQuality.medium);
        final label = TextPainter(
          text: TextSpan(
            text: 'p ${_steps[i]}',
            style: const TextStyle(fontFamily: 'Inter', fontSize: 18, color: Colors.white),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        label.paint(canvas, Offset(dst.left, dst.bottom + 6));
      }
      late ui.Image sheet;
      await tester.runAsync(() async {
        sheet = await recorder.endRecording().toImage(size.width.round(), size.height.round());
      });
      await write(name, sheet);
    }

    const phone = Size(390, 844);
    const tablet = Size(1180, 820);
    for (final MapEntry(key: from, value: name) in _spreadTurns.entries) {
      final frames = <ui.Image>[];
      for (final p in _steps) {
        final frame = await shoot(tablet, from: from, p: p);
        await write('$name-${(p * 100).round()}', frame);
        frames.add(frame);
      }
      await strip('strip-$name', frames);
    }
    for (final MapEntry(key: from, value: name) in _singleTurns.entries) {
      final frames = <ui.Image>[];
      for (final p in _steps) {
        final frame = await shoot(phone, from: from, p: p);
        await write('$name-${(p * 100).round()}', frame);
        frames.add(frame);
      }
      await strip('strip-$name', frames);
    }
    await tester.pumpWidget(const SizedBox());
    store.dispose();
    tester.view.reset();
  }, skip: !_capture);
}
