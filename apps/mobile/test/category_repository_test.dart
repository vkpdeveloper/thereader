import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/category.dart';
import 'package:thereader/data/repositories/category_repository.dart';
import 'package:thereader/data/storage/key_value_store.dart';

class Clock {
  DateTime now = DateTime.utc(2026, 10, 7, 10);
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

const book = CategoryItemRef.book('epub-ab12');
const article = CategoryItemRef.article('a1059795a40b472d904b598e027d39a2');

void main() {
  late MemoryKeyValueStore kv;
  late Clock clock;
  late CategoryRepository repo;

  setUp(() async {
    kv = MemoryKeyValueStore();
    clock = Clock();
    repo = CategoryRepository(kv, now: clock.call);
    await repo.load();
  });

  test('ids are lowercase version 4 UUIDs', () {
    final ids = {for (var i = 0; i < 50; i++) CategoryRepository.uuidV4()};
    expect(ids, hasLength(50));
    for (final id in ids) {
      expect(
        id,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
    }
  });

  test('names are trimmed and validated with a message for people', () async {
    final c = await repo.create('  Programming  ', CategoryColor.blue);
    expect(c.name, 'Programming');
    expect(
      () => repo.create('   ', CategoryColor.red),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          'Enter a name.',
        ),
      ),
    );
    expect(
      () => repo.create('x' * 61, CategoryColor.red),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('60'),
        ),
      ),
    );
    expect(
      () => repo.create('a\u0007b', CategoryColor.red),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => repo.create('a\nb', CategoryColor.red),
      throwsA(isA<FormatException>()),
    );
    expect(
      (await repo.create('x' * 60, CategoryColor.red)).name,
      hasLength(60),
    );
    // Duplicate names are allowed.
    await repo.create('Programming', CategoryColor.green);
    expect(repo.categories.where((c) => c.name == 'Programming'), hasLength(2));
    expect(() => repo.update(c.id, name: ''), throwsA(isA<FormatException>()));
  });

  test('create, update, assign, and reload from storage', () async {
    var notified = 0;
    repo.addListener(() => notified++);
    final first = await repo.create('Programming', CategoryColor.blue);
    clock.advance(const Duration(minutes: 1));
    final second = await repo.create('Philosophy', CategoryColor.purple);
    expect(repo.categories.map((c) => c.id), [
      first.id,
      second.id,
    ]); // oldest first
    expect(repo.byId(first.id)!.color, CategoryColor.blue);

    clock.advance(const Duration(minutes: 1));
    await repo.update(first.id, name: 'Code', color: CategoryColor.green);
    expect(repo.byId(first.id)!.name, 'Code');
    expect(repo.byId(first.id)!.color, CategoryColor.green);
    expect(repo.byId(first.id)!.updatedAt, clock.now);
    expect(repo.byId(first.id)!.createdAt, isNot(clock.now));
    expect(repo.categories.first.id, first.id); // renames do not reorder

    await repo.assign(book, first.id);
    clock.advance(const Duration(seconds: 1));
    await repo.assign(article, first.id);
    expect(repo.itemsIn(first.id), [article, book]); // newest assignment first
    expect(repo.categoryOf(book)!.id, first.id);
    clock.advance(const Duration(seconds: 1));
    await repo.assign(book, second.id); // move
    expect(repo.itemsIn(first.id), [article]);
    expect(repo.itemsIn(second.id), [book]);
    await repo.assign(article, null);
    expect(repo.categoryOf(article), isNull);
    expect(notified, greaterThan(0));
    expect(() => repo.assign(book, 'missing'), throwsArgumentError);
    await repo.flush();

    final reloaded = CategoryRepository(kv, now: clock.call);
    expect(reloaded.loaded, isFalse);
    await reloaded.load();
    expect(reloaded.loaded, isTrue);
    expect(reloaded.categories.map((c) => (c.id, c.name, c.color)), [
      (first.id, 'Code', CategoryColor.green),
      (second.id, 'Philosophy', CategoryColor.purple),
    ]);
    expect(reloaded.categoryOf(book)!.id, second.id);
    expect(reloaded.categoryOf(article), isNull);
    expect(
      reloaded.assignmentFor(article)!.categoryId,
      isNull,
    ); // the removal still syncs
  });

  test('no-op edits record nothing', () async {
    final c = await repo.create('Programming', CategoryColor.blue);
    await repo.assign(book, c.id);
    final at = repo.assignmentFor(book)!.updatedAt;
    clock.advance(const Duration(minutes: 1));
    await repo.assign(book, c.id);
    await repo.update(c.id, name: ' Programming ', color: CategoryColor.blue);
    await repo.assign(article, null);
    expect(repo.assignmentFor(book)!.updatedAt, at);
    expect(repo.recordFor(c.id)!.updatedAt, c.updatedAt);
    expect(repo.assignmentFor(article), isNull);
  });

  test('delete leaves a tombstone and moves its items out', () async {
    final keep = await repo.create('Keep', CategoryColor.red);
    final gone = await repo.create('Gone', CategoryColor.blue);
    await repo.assign(book, gone.id);
    await repo.assign(article, keep.id);
    clock.advance(const Duration(minutes: 1));
    await repo.delete(gone.id);
    expect(repo.categories.map((c) => c.id), [keep.id]);
    expect(repo.byId(gone.id), isNull);
    expect(repo.itemsIn(gone.id), isEmpty);
    expect(repo.categoryOf(book), isNull);
    expect(repo.assignmentFor(book)!.categoryId, isNull);
    expect(repo.assignmentFor(book)!.updatedAt, clock.now);
    expect(repo.categoryOf(article)!.id, keep.id);
    expect(repo.recordFor(gone.id)!.deleted, isTrue);
    // A deleted category cannot be edited or assigned to.
    await repo.update(gone.id, name: 'Back');
    expect(repo.byId(gone.id), isNull);
    expect(() => repo.assign(book, gone.id), throwsArgumentError);
  });

  test('edits move forward in time even when the clock goes back', () async {
    final c = await repo.create('Programming', CategoryColor.blue);
    clock.advance(const Duration(hours: -1));
    await repo.update(c.id, name: 'Code');
    expect(repo.byId(c.id)!.updatedAt.isAfter(c.updatedAt), isTrue);
  });

  test(
    'remote rows: last write wins, tombstones are final, unknown categories are uncategorized',
    () async {
      final c = await repo.create('Programming', CategoryColor.blue);
      clock.advance(const Duration(minutes: 1));
      await repo.update(
        c.id,
        name: 'Local',
      ); // pending, newer than the pull below
      final created = c.createdAt;
      final older = CategoryRecord(
        id: c.id,
        name: 'Old',
        color: 'red',
        createdAt: created,
        updatedAt: created.add(const Duration(seconds: 30)),
      );
      await repo.applyRemote(categories: [older]);
      expect(repo.byId(c.id)!.name, 'Local');

      final newer = CategoryRecord(
        id: c.id,
        name: 'Remote',
        color: 'sunset',
        createdAt: created,
        updatedAt: clock.now.add(const Duration(minutes: 1)),
      );
      await repo.applyRemote(categories: [newer]);
      expect(repo.byId(c.id)!.name, 'Remote');
      expect(
        repo.byId(c.id)!.color,
        CategoryColor.gray,
      ); // a newer build's colour
      await repo.update(c.id, name: 'Renamed');
      expect(repo.recordFor(c.id)!.color, 'sunset'); // kept on rename

      // An assignment to a category this device has not seen yet.
      final at = clock.now.add(const Duration(hours: 1));
      await repo.applyRemote(
        assignments: [
          CategoryAssignment(item: book, categoryId: 'future', updatedAt: at),
        ],
      );
      expect(repo.categoryOf(book), isNull);
      await repo.applyRemote(
        categories: [
          CategoryRecord(
            id: 'future',
            name: 'Later',
            color: 'teal',
            createdAt: at,
            updatedAt: at,
          ),
        ],
      );
      expect(repo.categoryOf(book)!.name, 'Later');
      expect(repo.itemsIn('future'), [book]);

      // A tombstone wins even when older than a local edit, and is final.
      await repo.applyRemote(
        categories: [
          CategoryRecord(
            id: 'future',
            name: '',
            color: 'gray',
            createdAt: at,
            updatedAt: at,
            deleted: true,
          ),
        ],
      );
      expect(repo.byId('future'), isNull);
      expect(repo.categoryOf(book), isNull);
      await repo.applyRemote(
        categories: [
          CategoryRecord(
            id: 'future',
            name: 'Again',
            color: 'teal',
            createdAt: at,
            updatedAt: at.add(const Duration(days: 1)),
          ),
        ],
      );
      expect(repo.byId('future'), isNull);

      // Older assignments do not replace a newer local one.
      await repo.assign(article, c.id);
      await repo.applyRemote(
        assignments: [
          CategoryAssignment(
            item: article,
            categoryId: null,
            updatedAt: c.createdAt,
          ),
        ],
      );
      expect(repo.categoryOf(article)!.id, c.id);
    },
  );

  test('a damaged record is skipped, not the whole store', () async {
    await kv.write(
      'categories.v1',
      jsonEncode({
        'categories': [
          {'id': 'x'},
          {
            'id': 'ok',
            'name': 'Fine',
            'color': 'red',
            'createdAt': '2026-10-07T10:00:00.000Z',
            'updatedAt': '2026-10-07T10:00:00.000Z',
            'deleted': false,
          },
        ],
        'assignments': [
          {
            'itemType': 'podcast',
            'itemId': 'p',
            'categoryId': 'ok',
            'updatedAt': '2026-10-07T10:00:00.000Z',
          },
          {
            'itemType': 'book',
            'itemId': 'b',
            'categoryId': 'ok',
            'updatedAt': '2026-10-07T10:00:00.000Z',
          },
        ],
      }),
    );
    final reloaded = CategoryRepository(kv);
    await reloaded.load();
    expect(reloaded.categories.single.name, 'Fine');
    expect(reloaded.itemsIn('ok'), [const CategoryItemRef.book('b')]);
  });

  test('syncable item ids match the API', () {
    expect(
      CategoryRepository.syncableItem(const CategoryItemRef.book('epub-ab12')),
      isTrue,
    );
    expect(
      CategoryRepository.syncableItem(
        const CategoryItemRef.book('pride-and-prejudice'),
      ),
      isTrue,
    );
    expect(
      CategoryRepository.syncableItem(const CategoryItemRef.book('Bad_Id')),
      isFalse,
    );
    expect(
      CategoryRepository.syncableItem(CategoryItemRef.book('a' * 129)),
      isFalse,
    );
    expect(CategoryRepository.syncableItem(article), isTrue);
    expect(
      CategoryRepository.syncableItem(
        const CategoryItemRef.article('deadbeef'),
      ),
      isFalse,
    );
  });
}
