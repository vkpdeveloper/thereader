import 'dart:typed_data';

import 'book_store.dart';

Future<BookStore> createBookStore() async => MemoryBookStore();

/// In-memory store used by the browser preview and by tests. Not durable.
class MemoryBookStore implements BookStore {
  final Map<String, Uint8List> files = {};

  @override
  bool get isDurable => false;

  @override
  String get description => 'Downloads last for this session only';

  @override
  Future<BookSink> openSink({required String bookId, required String version}) async =>
      _MemorySink(this, 'mem://$bookId/$version.epub');

  @override
  Future<bool> exists(String pathOrKey) async => files.containsKey(pathOrKey);

  @override
  Future<int?> sizeOf(String pathOrKey) async => files[pathOrKey]?.length;

  @override
  Future<BookFile> open(String pathOrKey) async {
    final bytes = files[pathOrKey];
    if (bytes == null) throw StateError('Missing file $pathOrKey');
    return _MemoryBookFile(bytes);
  }

  @override
  Future<void> delete(String pathOrKey) async => files.remove(pathOrKey);

  @override
  Future<void> deleteBook(String bookId) async =>
      files.removeWhere((k, _) => k.startsWith('mem://$bookId/'));
}

class _MemorySink implements BookSink {
  _MemorySink(this.store, this.key);
  final MemoryBookStore store;
  final String key;
  final BytesBuilder _builder = BytesBuilder(copy: false);

  @override
  Future<void> add(List<int> chunk) async => _builder.add(chunk);

  @override
  Future<String> commit() async {
    store.files[key] = _builder.takeBytes();
    return key;
  }

  @override
  Future<void> abort() async => _builder.clear();
}

class _MemoryBookFile implements BookFile {
  _MemoryBookFile(this.bytes);
  final Uint8List bytes;

  @override
  int get length => bytes.length;

  @override
  String? get path => null;

  @override
  Future<Uint8List> readRange(int start, int end) async => Uint8List.sublistView(bytes, start, end);

  @override
  Future<Uint8List> readAll() async => bytes;

  @override
  Future<void> close() async {}
}
