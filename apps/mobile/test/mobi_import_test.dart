import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/import/epub_import_service.dart';
import 'package:thereader/data/import/import_platform_io.dart';
import 'package:thereader/data/import/mobi_converter.dart';
import 'package:thereader/data/import/upload_api.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:xml/xml.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final edition in ['mobi7', 'kf8']) {
    test('imports the real $edition MOBI as a complete EPUB', () async {
      final source = File('test/fixtures/mobi/alice-$edition.mobi');
      final converted = await prepareBook(source.path);
      try {
        final metadata = await inspectEpub(converted);
        expect(metadata['title'], "Alice's Adventures in Wonderland");
        expect(metadata['author'], 'Lewis Carroll');
        final epub = await File(converted).readAsBytes();
        final archive = ZipDecoder().decodeBytes(epub);
        final entries = {for (final file in archive.files) file.name: file};
        expect(
          entries['mimetype']!.content,
          utf8.encode('application/epub+zip'),
        );
        expect(
          entries.keys.where((name) => name.startsWith('OEBPS/Text/')),
          isNotEmpty,
        );
        expect(
          entries.keys.where((name) => name.startsWith('OEBPS/Images/')),
          isNotEmpty,
        );

        for (final entry in entries.entries) {
          final name = entry.key;
          if (!RegExp(r'\.(xhtml|svg|opf|ncx)$').hasMatch(name)) continue;
          final text = utf8.decode(entry.value.content as List<int>);
          XmlDocument.parse(text);
          expect(text, isNot(contains('kindle:')), reason: name);
          for (final match in RegExp(
            r'''(?:href|src)=["']([^"']+)["']''',
          ).allMatches(text)) {
            final link = match.group(1)!;
            final uri = Uri.tryParse(link);
            if (uri == null || uri.hasScheme || link.startsWith('#')) continue;
            final target = Uri(path: name).resolve(link).path;
            expect(
              entries.containsKey(Uri.decodeComponent(target)),
              isTrue,
              reason: '$name -> $link',
            );
          }
        }

        if (edition == 'kf8') {
          expect(
            entries.keys.where((name) => name.startsWith('OEBPS/Text/')).length,
            19,
          );
          expect(entries.keys.where((name) => name.endsWith('.css')).length, 3);
          expect(entries.keys.any((name) => name.endsWith('.svg')), isTrue);
          final cover = utf8.decode(
            entries['OEBPS/Text/part0000.xhtml']!.content as List<int>,
          );
          expect(cover, contains('../Images/image10004.svg'));
          final toc = utf8.decode(
            entries['OEBPS/Text/part0018.xhtml']!.content as List<int>,
          );
          expect(toc, contains('part0004.xhtml#'));
        } else {
          final body = utf8.decode(
            entries['OEBPS/Text/part0000.xhtml']!.content as List<int>,
          );
          expect(body, contains('CHAPTER I. Down the Rabbit-Hole'));
          expect(body, contains('CHAPTER XII. Alice’s Evidence'));
          expect(body, contains('mobi-pos-'));
          expect(body, isNot(contains('filepos=')));
          expect(body, isNot(contains('mbp:pagebreak')));
        }
      } finally {
        await cleanPreparedBook(source.path, converted);
      }
      expect(await File(converted).exists(), isFalse);
    });
  }

  test(
    'conversion is stable for repeat imports and rejects damaged MOBI',
    () async {
      final source = await File(
        'test/fixtures/mobi/alice-kf8.mobi',
      ).readAsBytes();
      final first = convertMobi(source);
      final second = convertMobi(source);
      expect(sha256.convert(first), sha256.convert(second));
      expect(() => convertMobi(source.sublist(0, 100)), throwsException);
    },
  );

  test(
    'MOBI enters the ordinary durable EPUB library and upload queue',
    () async {
      final temp = await Directory.systemTemp.createTemp(
        'reader-mobi-library-',
      );
      final books = IoBookStore(Directory('${temp.path}/books'));
      final store = MemoryKeyValueStore();
      final library = LibraryRepository(store: store, bookStore: books);
      final client = ApiClient(baseUrl: 'https://books.example');
      await library.load();
      final imports = EpubImportService(
        bookStore: books,
        library: library,
        store: store,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (origin) => _OfflineUpload(origin),
      );
      try {
        final path = 'test/fixtures/mobi/alice-kf8.mobi';
        final first = await imports.importPath(path);
        expect(first, isNotNull);
        expect(first!.download.isReady, isTrue);
      expect(first.download.path, endsWith('.epub'));
      expect(
        await inspectEpub('${books.root.path}/${first.download.path}'),
          containsPair('sha256', first.book.sha256),
        );
        expect(imports.isPending(first.id), isTrue);

        final second = await imports.importPath(path);
        expect(second!.id, first.id);
        expect(library.entries.length, 1);
      } finally {
        imports.dispose();
        client.close();
        library.dispose();
        await temp.delete(recursive: true);
      }
    },
  );
}

class _OfflineUpload extends UploadApi {
  _OfflineUpload(super.origin);

  @override
  Future<PreparedUpload> prepare(Book book) async =>
      throw ApiException('Offline', isNetwork: true);
}
