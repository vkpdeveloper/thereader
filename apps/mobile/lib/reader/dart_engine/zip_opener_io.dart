import 'package:archive/archive_io.dart';

import '../../data/storage/book_store.dart';

Future<Archive> openArchive(BookFile file) async {
  final path = file.path;
  if (path != null) {
    // Lazy: reads the central directory from disk; entry bytes inflate on access.
    final input = InputFileStream(path);
    return ZipDecoder().decodeStream(input, verify: false);
  }
  return ZipDecoder().decodeBytes(await file.readAll(), verify: false);
}
