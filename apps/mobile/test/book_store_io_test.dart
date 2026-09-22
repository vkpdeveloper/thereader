import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/storage/book_store_io.dart';

void main() {
  test('relative storage keys survive moving an application container', () async {
    final root = await Directory.systemTemp.createTemp('reader-storage-');
    addTearDown(() => root.delete(recursive: true));
    final first = IoBookStore(Directory('${root.path}/old/books'));
    final sink = await first.openSink(bookId: 'test', version: '1');
    await sink.add([1, 2, 3]);
    final key = await sink.commit();
    expect(key, 'test/1.epub');
    await Directory('${root.path}/old').rename('${root.path}/new');
    final second = IoBookStore(Directory('${root.path}/new/books'));
    expect(await second.exists(key), isTrue);
    expect(await second.exists('${root.path}/old/books/test/1.epub'), isTrue);
    final file = await second.open(key);
    expect(await file.readAll(), [1, 2, 3]);
    await file.close();
  });
  test('aborting replacement keeps the previously verified edition', () async {
    final root = await Directory.systemTemp.createTemp('reader-storage-');
    addTearDown(() => root.delete(recursive: true));
    final store = IoBookStore(root);
    final first = await store.openSink(bookId: 'book', version: '1');
    await first.add([1, 2, 3]);
    final key = await first.commit();
    final replacement = await store.openSink(bookId: 'book', version: '1');
    await replacement.add([4, 5]);
    await replacement.abort();
    expect(await store.sizeOf(key), 3);
  });
}
