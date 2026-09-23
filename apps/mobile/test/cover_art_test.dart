import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/covers/cover_cache.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/features/shared/cover_art.dart';

Book _book(String sha) => Book(
  id: 'cover-$sha',
  version: '1',
  title: 'Cover Fixture',
  author: 'The Reader',
  description: '',
  language: 'en',
  subjects: const [],
  coverUrl: null,
  downloadUrl: '/v1/books/cover/download',
  fileSize: 1,
  sha256: sha,
  updatedAt: DateTime.utc(2026, 9, 23),
);

Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  Canvas(recorder).drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF3366FF),
  );
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

void main() {
  // Frame ratios differ from real artwork (wide, square, tall); the artwork
  // must still cover the whole frame rather than letterbox inside it.
  for (final (label, w, h, sha) in [
    ('wide', 400, 200, 'a' * 64),
    ('square', 300, 300, 'b' * 64),
    ('tall', 200, 400, 'c' * 64),
  ]) {
    testWidgets('$label artwork cover-fills the 3:4 frame', (tester) async {
      await tester.runAsync(() async {
        final cache = await CoverCache.shared;
        await cache.storeEmbedded(sha, await _png(w, h));
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Center(child: CoverArt(book: _book(sha), width: 120)),
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();

      final image = tester.widget<Image>(find.byType(Image));
      expect(image.fit, BoxFit.cover);
      expect(image.alignment, Alignment.center);
      expect(tester.getSize(find.byType(CoverArt)), const Size(120, 160));
      expect(tester.getSize(find.byType(Image)), const Size(120, 160));
      expect(
        find.ancestor(of: find.byType(Image), matching: find.byType(ClipRRect)),
        findsOneWidget,
      );
    });
  }

  testWidgets('missing artwork keeps the generated plate at frame size', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Center(child: CoverArt(book: _book('d' * 64), width: 96)),
      ),
    );
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(find.byType(Image), findsNothing);
    expect(find.text('Cover Fixture'), findsOneWidget);
    expect(tester.getSize(find.byType(CoverArt)), const Size(96, 128));
  });
}
