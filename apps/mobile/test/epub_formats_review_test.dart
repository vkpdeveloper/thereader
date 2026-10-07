import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/dart_engine/dart_reader_view.dart';
import 'package:thereader/reader/dart_engine/epub_package.dart';

/// Renders chapters of the committed enhancer sampler
/// (apps/web/fixtures/enhance-sampler.epub) through the Dart engine to PNGs
/// for visual review, with the real reading and KaTeX fonts loaded. Skipped
/// unless REVIEW_OUT names a directory:
///
///   flutter test test/epub_formats_review_test.dart --dart-define=REVIEW_OUT=/tmp/shots
///
/// `--dart-define=REVIEW_CHAPTERS=katex,svg` limits the chapters.

const _out = String.fromEnvironment('REVIEW_OUT');
const _chapters = String.fromEnvironment('REVIEW_CHAPTERS', defaultValue: 'katex,mathjax3,mathjax3svg,mathjax2,svg,paper,attrs,mathml2');

class _BytesFile implements BookFile {
  _BytesFile(this.bytes);
  final Uint8List bytes;
  @override
  int get length => bytes.length;
  @override
  String? get path => null;
  @override
  Future<Uint8List> readAll() async => bytes;
  @override
  Future<Uint8List> readRange(int start, int end) async => bytes.sublist(start, end);
  @override
  Future<void> close() async {}
}

Future<void> _loadFonts() async {
  final libron = FontLoader('Libron');
  for (final face in ['Regular', 'Italic', 'Bold', 'BoldItalic']) {
    libron.addFont(rootBundle.load('assets/fonts/Libron-$face.ttf'));
  }
  await libron.load();
  // Code renders in the platform monospace; the test font would draw boxes.
  const mono = '/System/Library/Fonts/Supplemental/Courier New.ttf';
  if (File(mono).existsSync()) {
    for (final family in ['monospace', 'Menlo']) {
      await (FontLoader(family)..addFont(Future.value(ByteData.sublistView(File(mono).readAsBytesSync())))).load();
    }
  }
  const katex = {
    'KaTeX_Main': ['Regular', 'Italic', 'Bold', 'BoldItalic'],
    'KaTeX_Math': ['Italic', 'BoldItalic'],
    'KaTeX_AMS': ['Regular'],
    'KaTeX_Caligraphic': ['Regular', 'Bold'],
    'KaTeX_Fraktur': ['Regular', 'Bold'],
    'KaTeX_SansSerif': ['Regular', 'Italic', 'Bold'],
    'KaTeX_Script': ['Regular'],
    'KaTeX_Size1': ['Regular'],
    'KaTeX_Size2': ['Regular'],
    'KaTeX_Size3': ['Regular'],
    'KaTeX_Size4': ['Regular'],
    'KaTeX_Typewriter': ['Regular'],
  };
  for (final MapEntry(key: family, value: faces) in katex.entries) {
    final loader = FontLoader('packages/flutter_math_fork/$family');
    for (final face in faces) {
      loader.addFont(rootBundle.load('packages/flutter_math_fork/lib/katex_fonts/fonts/$family-$face.ttf'));
    }
    await loader.load();
  }
}

void main() {
  testWidgets('sampler chapters render for review', skip: _out.isEmpty, (tester) async {
    await tester.runAsync(_loadFonts);
    const width = 430.0;
    const height = 1100.0;
    tester.view.physicalSize = const Size(width * 2, height * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final bytes = File('../web/fixtures/enhance-sampler.epub').readAsBytesSync();
    Directory(_out).createSync(recursive: true);
    for (final id in _chapters.split(',')) {
      // Disposing a controller closes its book.
      final package = (await tester.runAsync(() => EpubPackage.open(_BytesFile(bytes))))!;
      final href = package.spine.firstWhere((s) => s.href.split('/').last == '$id.xhtml').href;
      final controller = DartReaderController(
        package: package,
        prefs: const ReaderPreferences(),
        initial: ReadingLocator(href: href, progression: 0),
      );
      final boundary = GlobalKey();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(key: boundary, child: Scaffold(body: DartReaderView(controller: controller))),
      ));
      for (var i = 0; i < 8; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
        await tester.pump(const Duration(milliseconds: 50));
      }
      final render = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final png = await tester.runAsync(() async {
        final image = await render.toImage(pixelRatio: 2);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        return data!.buffer.asUint8List();
      });
      File('$_out/$id.png').writeAsBytesSync(png!);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    }
  });
}
