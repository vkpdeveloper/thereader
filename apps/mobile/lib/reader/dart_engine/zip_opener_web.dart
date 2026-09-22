import 'package:archive/archive.dart';

import '../../data/storage/book_store.dart';

Future<Archive> openArchive(BookFile file) async =>
    ZipDecoder().decodeBytes(await file.readAll(), verify: false);

Future<void> closeArchive(Archive archive) => archive.clear();
