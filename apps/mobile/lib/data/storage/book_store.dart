import 'dart:typed_data';

import 'book_store_stub.dart'
    if (dart.library.io) 'book_store_io.dart'
    if (dart.library.js_interop) 'book_store_web.dart'
    as impl;

/// A write handle for an in-progress download. Bytes are streamed in; nothing
/// is buffered whole in memory on native platforms.
abstract class BookSink {
  Future<void> add(List<int> chunk);

  /// Finalises the write and returns the durable path (or key) of the file.
  Future<String> commit();

  /// Discards partial data.
  Future<void> abort();
}

/// Random-access reader over a stored EPUB. Implementations must not load the
/// whole file just to answer [length].
abstract class BookFile {
  int get length;

  /// Filesystem path when the file lives on disk (native), else null.
  String? get path;
  Future<Uint8List> readRange(int start, int end);
  Future<Uint8List> readAll();
  Future<void> close();
}

/// A temporary online reader lease, never a verified offline file.
abstract class ProvisionalBookFile implements BookFile {}

extension BookFileState on BookFile {
  bool get isProvisional => this is ProvisionalBookFile;
}

/// Durable application storage for downloaded EPUBs. Native platforms write to
/// the application support directory (not caches). Web keeps files in memory
/// for the session only and says so via [isDurable].
abstract class BookStore {
  bool get isDurable;

  /// Human-readable description shown in Settings.
  String get description;

  Future<BookSink> openSink({required String bookId, required String version});
  Future<bool> exists(String pathOrKey);
  Future<int?> sizeOf(String pathOrKey);
  Future<BookFile> open(String pathOrKey);
  Future<void> delete(String pathOrKey);
  Future<void> deleteBook(String bookId);

  static Future<BookStore> create() => impl.createBookStore();
}
