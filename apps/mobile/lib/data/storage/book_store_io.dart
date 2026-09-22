import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'book_store.dart';

Future<BookStore> createBookStore() async {
  final support = await getApplicationSupportDirectory();
  final store = IoBookStore(Directory(p.join(support.path, 'books')));
  await store.clearInterrupted();
  return store;
}

class IoBookStore implements BookStore {
  IoBookStore(this.root);

  final Directory root;

  Future<void> clearInterrupted() async {
    if (!await root.exists()) return;
    await for (final item in root.list(recursive: true, followLinks: false)) {
      if (item is File && item.path.endsWith('.part')) await item.delete();
    }
  }

  @override
  bool get isDurable => true;

  @override
  String get description => 'Application support storage (kept across launches, not a cache).';

  Directory _bookDir(String bookId) => Directory(p.join(root.path, _safe(bookId)));

  static String _safe(String s) => s.replaceAll(RegExp(r'[^a-z0-9._-]'), '_');

  @override
  Future<BookSink> openSink({required String bookId, required String version}) async {
    final dir = _bookDir(bookId);
    await dir.create(recursive: true);
    final finalPath = p.join(dir.path, '${_safe(version)}.epub');
    final partPath = '$finalPath.part';
    final part = File(partPath);
    if (await part.exists()) await part.delete();
    final sink = part.openWrite();
    return _IoSink(part, File(finalPath), sink, p.relative(finalPath, from: root.path));
  }

  File _resolve(String key) {
    // Migrate absolute paths from older installs when iOS moves the container.
    final relative = p.isAbsolute(key) ? p.join(p.basename(p.dirname(key)), p.basename(key)) : key;
    final path = p.normalize(p.join(root.path, relative));
    if (!p.isWithin(root.path, path)) throw ArgumentError('Invalid storage key');
    return File(path);
  }

  @override
  Future<bool> exists(String pathOrKey) => _resolve(pathOrKey).exists();

  @override
  Future<int?> sizeOf(String pathOrKey) async {
    final f = _resolve(pathOrKey);
    return await f.exists() ? f.length() : null;
  }

  @override
  Future<BookFile> open(String pathOrKey) async {
    final f = _resolve(pathOrKey);
    final raf = await f.open();
    return _IoBookFile(raf, await raf.length(), f.path);
  }

  @override
  Future<void> delete(String pathOrKey) async {
    final f = _resolve(pathOrKey);
    if (await f.exists()) await f.delete();
  }

  @override
  Future<void> deleteBook(String bookId) async {
    final dir = _bookDir(bookId);
    if (await dir.exists()) await dir.delete(recursive: true);
  }
}

class _IoSink implements BookSink {
  _IoSink(this.part, this.target, this.sink, this.key);

  final String key;

  final File part;
  final File target;
  final IOSink sink;

  @override
  Future<void> add(List<int> chunk) async {
    sink.add(chunk);
    // Apply disk backpressure instead of allowing a large HTTP response to queue
    // the complete publication in IOSink's in-memory write buffer.
    await sink.flush();
  }

  @override
  Future<String> commit() async {
    await sink.flush();
    await sink.close();
    await part.rename(target.path);
    return key;
  }

  @override
  Future<void> abort() async {
    try {
      await sink.close();
    } catch (_) {}
    if (await part.exists()) await part.delete();
  }
}

class _IoBookFile implements BookFile {
  _IoBookFile(this.raf, this.length, this.path);

  final RandomAccessFile raf;
  @override
  final String path;
  @override
  final int length;

  @override
  Future<Uint8List> readRange(int start, int end) async {
    await raf.setPosition(start);
    return raf.read(end - start);
  }

  @override
  Future<Uint8List> readAll() => readRange(0, length);

  @override
  Future<void> close() => raf.close();
}
