import 'package:archive/archive_io.dart';

import '../../data/storage/book_store.dart';

final _inputs = Expando<InputFileStream>();

Future<Archive> openArchive(BookFile file) async {
  final path = file.path;
  if (path != null) {
    // Lazy: reads the central directory from disk; entry bytes inflate on access.
    final input = InputFileStream(path);
    try {
      final archive = ZipDecoder().decodeStream(input, verify: false);
      _inputs[archive] = input;
      return archive;
    } catch (_) {
      await input.close();
      rethrow;
    }
  }
  return ZipDecoder().decodeBytes(await file.readAll(), verify: false);
}

Future<void> closeArchive(Archive archive) async {
  await archive.clear();
  await _inputs[archive]?.close();
}
