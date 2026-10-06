import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/category.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/categories/category_screen.dart';
import 'package:thereader/features/categories/category_shelf.dart';
import 'package:thereader/features/library/book_grid_item.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

import 'support/fake_category_store.dart';

LibraryEntry _entry(String id, String title, int day) => LibraryEntry(
  book: Book.fromJson({
    'id': id,
    'title': title,
    'author': 'A. Writer',
    'downloadUrl': '',
    'fileSize': 1,
    'sha256': id,
  }),
  source: BookSource.sample,
  origin: 'sample',
  addedAt: DateTime.utc(2026, 10, day),
);

final _books = [
  _entry('sicp', 'Structure and Interpretation', 1),
  _entry('walden', 'Walden', 2),
  _entry('dune', 'Dune', 3),
];

Future<(AppServices, FakeCategoryStore)> _services() async {
  final kv = MemoryKeyValueStore();
  await kv.writeJson('library.v1', {
    'entries': [for (final e in _books) e.toJson()],
  });
  final settings = SettingsRepository(kv);
  await settings.load();
  final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
  await library.load();
  final categories = FakeCategoryStore();
  return (
    AppServices(
      settings: settings,
      library: library,
      readerService: ReaderService(engines: const [DartReaderEngine()]),
      catalogSource: SampleCatalogSource(),
      categories: categories,
    ),
    categories,
  );
}

/// A book's tile in a cover grid (shelf covers also print the title).
Finder _inGrid(String title) => find.descendant(of: find.byType(BookGridItem), matching: find.text(title));

/// An iPhone-sized portrait screen.
void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1206, 2622);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  setUp(rootBundle.clear);

  testWidgets('the library hides filed books and shows a bookcase per category', (tester) async {
    _phone(tester);
    final (services, store) = await _services();
    final programming = await store.create('Programming', CategoryColor.blue);
    await store.create('Someday', CategoryColor.purple);
    await store.assign(const CategoryItemRef.book('sicp'), programming.id);

    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();

    expect(_inGrid('Walden'), findsOneWidget);
    expect(_inGrid('Dune'), findsOneWidget);
    expect(_inGrid('Structure and Interpretation'), findsNothing);

    expect(find.byType(CategoryShelf), findsNWidgets(2));
    expect(find.text('CATEGORIES'), findsOneWidget);
    expect(find.text('Programming'), findsOneWidget);
    expect(find.text('1 item'), findsOneWidget);
    // An empty category is an intentionally empty shelf, not a hidden one.
    expect(find.text('Empty shelf'), findsOneWidget);

    // Pressing blooms without opening; a tap opens the category.
    final shelf = find.widgetWithText(CategoryShelf, 'Programming');
    final press = await tester.startGesture(tester.getCenter(shelf));
    // The press registers after the tap timeout, then the spring runs.
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 150));
    final opened = tester.widget<ShelfCase>(find.descendant(of: shelf, matching: find.byType(ShelfCase)));
    expect(opened.bloom, greaterThan(0.3));
    await press.up();
    await tester.pumpAndSettle();
    expect(find.byType(CategoryScreen), findsOneWidget);
    expect(_inGrid('Structure and Interpretation'), findsOneWidget);
  });

  testWidgets('Add to… creates the first category, then picks it', (tester) async {
    _phone(tester);
    final (services, store) = await _services();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    expect(find.byType(CategoryShelf), findsNothing);

    await tester.longPress(_inGrid('Walden'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add to…'));
    await tester.pumpAndSettle();

    // No categories yet: the sheet opens on the create step.
    expect(find.text('NEW CATEGORY'), findsOneWidget);
    final create = find.widgetWithText(InkWell, 'Create');
    expect(tester.widget<InkWell>(create).onTap, isNull, reason: 'an empty name cannot be created');
    await tester.enterText(find.byType(TextField), 'x' * (maxCategoryName + 1));
    await tester.pump();
    expect(find.textContaining('at most $maxCategoryName'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '  Programming ');
    await tester.tap(find.bySemanticsLabel('Green'));
    await tester.pump();
    await tester.tap(create);
    await tester.pumpAndSettle();

    // The picker, with the new category chosen and one tap from filing.
    expect(find.text('ADD TO'), findsOneWidget);
    expect(find.text('New category…'), findsOneWidget);
    await tester.tap(find.text('Add to Programming'));
    await tester.pumpAndSettle();

    final category = store.categories.single;
    expect(category.name, 'Programming');
    expect(category.color, CategoryColor.green);
    expect(store.categoryOf(const CategoryItemRef.book('walden'))?.id, category.id);
    expect(find.text('Added to Programming'), findsOneWidget);
    expect(_inGrid('Walden'), findsNothing);
    expect(find.byType(CategoryShelf), findsOneWidget);

    // Next time the picker comes first; choosing a row files at once.
    await tester.longPress(_inGrid('Dune'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add to…'));
    await tester.pumpAndSettle();
    expect(find.text('NEW CATEGORY'), findsNothing);
    await tester.tap(find.bySemanticsLabel('Programming'));
    await tester.pumpAndSettle();
    expect(store.itemsIn(category.id).map((r) => r.id), ['dune', 'walden']);
    expect(_inGrid('Dune'), findsNothing);
  });

  testWidgets('deleting a category asks first and returns its items to the library', (tester) async {
    _phone(tester);
    final (services, store) = await _services();
    final programming = await store.create('Programming', CategoryColor.blue);
    await store.assign(const CategoryItemRef.book('sicp'), programming.id);
    await store.assign(const CategoryItemRef.book('dune'), programming.id);

    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(CategoryShelf, 'Programming'));
    await tester.pumpAndSettle();

    expect(find.text('2 books'), findsOneWidget);
    await tester.tap(find.byTooltip('Category options'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete category'));
    await tester.pumpAndSettle();
    expect(find.text('Delete “Programming”?'), findsOneWidget);
    await tester.tap(find.text('Keep'));
    await tester.pumpAndSettle();
    expect(store.categories, hasLength(1));

    await tester.tap(find.byTooltip('Category options'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete category'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(store.categories, isEmpty);
    expect(find.byType(CategoryScreen), findsNothing);
    expect(find.byType(CategoryShelf), findsNothing);
    expect(find.text('Deleted Programming. 2 items are back in your library.'), findsOneWidget);
    for (final title in ['Structure and Interpretation', 'Walden', 'Dune']) {
      expect(_inGrid(title), findsOneWidget);
    }
  });
}
