import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/features/book/book_detail_screen.dart';

import 'cloud_ui_test.dart' show makeServices, pumpApp;

/// Comics in the library and on the book page: a quiet label, no duplicate
/// "Comics" subject, and reading online beside the download button.
LibraryEntry _comic() => LibraryEntry(
  book: Book.fromJson({
    'id': 'comic-abc',
    'title': 'Little Nemo',
    'author': 'Winsor McCay',
    'downloadUrl': '/v1/books/comic-abc/download',
    'fileSize': 4096,
    'sha256': 'abc',
    'subjects': ['Comics'],
    'format': 'comic',
  }),
  source: BookSource.api,
  origin: 'http://api.test',
  addedAt: DateTime(2026),
  download: const DownloadState(),
);

void main() {
  setUp(rootBundle.clear);

  testWidgets('a comic is labelled quietly and reads online before it downloads', (tester) async {
    final services = await makeServices(existing: _comic());
    await pumpApp(tester, services);
    expect(find.text('COMIC'), findsOneWidget);
    expect(find.text('Not downloaded'), findsOneWidget);

    await tester.longPress(
      find.byWidgetPredicate((w) => w is Text && w.data == 'Little Nemo' && w.maxLines == 2),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Book details'));
    await tester.pumpAndSettle();
    expect(find.byType(BookDetailScreen), findsOneWidget);
    expect(find.text('COMIC'), findsOneWidget);
    expect(find.text('COMICS'), findsNothing);
    expect(find.text('Download · 4.0 KB'), findsOneWidget);
    expect(find.text('Read online'), findsOneWidget);
  });
}
