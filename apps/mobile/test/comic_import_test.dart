import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rar/rar.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/comic/comic_import_io.dart';
import 'package:thereader/data/import/epub_import_service.dart';
import 'package:thereader/data/import/upload_api.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/data/storage/key_value_store.dart';

List<int> _b(String latin1Text) => latin1.encode(latin1Text);

/// docs/comics.md, "Reference vector", in a scrambled archive order.
final _vector = <String, List<int>>{
  'Comic/notes.txt': _b('notes'),
  'Comic/page10.jpg': _b('\xff\xd8\xff ten'),
  'Comic\\page2.JPG': _b('\xff\xd8\xff two'),
  'Comic/.hidden.jpg': _b('hidden'),
  'Comic/ComicInfo.xml': utf8.encode(
    '<?xml version="1.0"?><ComicInfo><Series>Vector</Series></ComicInfo>',
  ),
  'Comic/page02b.png': _b('\x89PNG two-b'),
  '/Comic/Cover.webp': _b('RIFF cover'),
  'Comic/__MACOSX/._page2.jpg': _b('junk'),
  'Comic/extras/001.jpg': _b('\xff\xd8\xff extra'),
};

const _vectorSha =
    'f425a5b825fd0263e84f6a9106d6ca08e240adb2982c0007e4c644835dace109';

final _rar5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0, 0, 0];

/// Stands in for the native library: writes entry i to `<destination>/i`.
RarExtractor _fakeRar(Map<String, List<int>> entries, {RarFailure? fail}) =>
    (archive, destination, {required maxBytes}) async {
      expect(Directory(destination).listSync(), isEmpty);
      if (fail != null) throw RarException(fail, 'fake');
      final names = entries.keys.toList();
      for (var i = 0; i < names.length; i++) {
        File('$destination/$i').writeAsBytesSync(entries[names[i]]!);
      }
      return names;
    };

List<int> _zip(Map<String, List<int>> entries, {bool encrypt = false}) {
  final archive = Archive();
  for (final MapEntry(:key, :value) in entries.entries) {
    archive.add(ArchiveFile.bytes(key, value));
  }
  final bytes = Uint8List.fromList(ZipEncoder().encode(archive));
  if (encrypt) {
    // Set the "encrypted" flag on every central directory record.
    final view = ByteData.sublistView(bytes);
    for (var i = 0; i + 4 <= bytes.length; i++) {
      if (view.getUint32(i, Endian.little) == 0x02014b50) {
        view.setUint16(
          i + 8,
          view.getUint16(i + 8, Endian.little) | 1,
          Endian.little,
        );
      }
    }
  }
  return bytes;
}

final _png = base64.decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory temp;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp('reader-comic-import-');
  });
  tearDown(() => temp.delete(recursive: true));

  group('CBR conversion', () {
    test('repacks to the reference vector and frees the pages', () async {
      final cbr = File('${temp.path}/Vector.cbr')..writeAsBytesSync(_rar5);
      final work = await Directory('${temp.path}/work').create();
      final cbz = await prepareComic(
        cbr.path,
        work,
        extract: _fakeRar(_vector),
      );
      final bytes = File(cbz).readAsBytesSync();
      expect(bytes.length, 794);
      expect(sha256.convert(bytes).toString(), _vectorSha);
      expect(Directory('${work.path}/pages').existsSync(), isFalse);

      final metadata = await inspectComic(cbz, 'Vector.cbr');
      expect(metadata['sha256'], _vectorSha);
      expect(metadata['fileSize'], 794);
      expect(metadata['format'], 'comic');
      expect(metadata['title'], 'Vector');
      expect(metadata['author'], 'Unknown');
      expect(metadata['subjects'], ['Comics']);
      // Page 1 is `RIFF cover`, not a usable image.
      expect(metadata.containsKey('coverBytes'), isFalse);
    });

    test('traversal names are dropped, later duplicates win', () async {
      final cbr = File('${temp.path}/x.cbr')..writeAsBytesSync(_rar5);
      final work = await Directory('${temp.path}/work').create();
      final extract = _fakeRar({
        '../ComicInfo.xml': utf8.encode(
          '<ComicInfo><Title>Evil</Title></ComicInfo>',
        ),
        'a/../../escape.jpg': _b('\xff\xd8\xff x'),
        'p1.jpg': _b('first'),
      });
      final cbz = await prepareComic(
        cbr.path,
        work,
        extract: (archive, destination, {required maxBytes}) async {
          final names = await extract(archive, destination, maxBytes: maxBytes);
          File('$destination/3').writeAsBytesSync(_b('second'));
          return [...names, 'p1.jpg'];
        },
      );
      final archive = ZipDecoder().decodeBytes(File(cbz).readAsBytesSync());
      expect(archive.files.map((f) => f.name), ['p1.jpg']);
      expect(utf8.decode(archive.files.single.content), 'second');
      final metadata = await inspectComic(cbz, 'My_Comic 01.cbr');
      expect(metadata['title'], 'My Comic 01');
    });

    test('refusals carry clear messages', () async {
      final work = await Directory('${temp.path}/work').create();
      final cbr = File('${temp.path}/x.cbr')..writeAsBytesSync(_rar5);
      Future<void> refuses(RarExtractor extract, String message) => expectLater(
        prepareComic(cbr.path, work, extract: extract),
        throwsA(
          isA<FormatException>().having((e) => e.message, 'message', message),
        ),
      );
      await refuses(
        _fakeRar(const {}, fail: RarFailure.encrypted),
        'Password-protected comics are not supported.',
      );
      await refuses(
        _fakeRar(const {}, fail: RarFailure.tooLarge),
        'Comics are limited to 1 GiB.',
      );
      await refuses(
        _fakeRar(const {}, fail: RarFailure.damaged),
        'This CBR is damaged and cannot be read.',
      );
      await refuses(
        _fakeRar({'notes.txt': _b('no pages')}),
        'This comic has no page images.',
      );

      for (final (head, message) in [
        ([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 'CB7 (7-Zip)'),
        (ascii.encode('%PDF-1.7'), 'PDF'),
        (ascii.encode('plain text'), 'not a CBZ or CBR'),
      ]) {
        cbr.writeAsBytesSync(head);
        await expectLater(
          prepareComic(cbr.path, work, extract: _fakeRar(_vector)),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains(message),
            ),
          ),
        );
      }
      final tar = Uint8List(512)..setRange(257, 262, ascii.encode('ustar'));
      cbr.writeAsBytesSync(tar);
      await expectLater(
        prepareComic(cbr.path, work, extract: _fakeRar(_vector)),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('CBT'),
          ),
        ),
      );
    });

    test('a ZIP named .cbr is a CBZ and is used as is', () async {
      final file = File('${temp.path}/zip.cbr')
        ..writeAsBytesSync(_zip({'1.jpg': _png}));
      final work = await Directory('${temp.path}/work').create();
      expect(
        await prepareComic(file.path, work, extract: _fakeRar(const {})),
        file.path,
      );
    });
  });

  group('CBZ validation', () {
    Future<Map<String, dynamic>> inspect(
      List<int> bytes, [
      String name = 'x.cbz',
    ]) {
      final file = File('${temp.path}/$name')..writeAsBytesSync(bytes);
      return inspectComic(file.path, name);
    }

    Matcher refusal(String message) => throwsA(
      isA<FormatException>().having(
        (e) => e.message,
        'message',
        contains(message),
      ),
    );

    test('reads ComicInfo and page 1 as the cover from a deflated CBZ', () async {
      final bytes = _zip({
        'issue/ComicInfo.xml': utf8.encode(
          '<ComicInfo><Series>Saga</Series><Number>3</Number><Writer>BKV</Writer>'
          '<Genre>Space, Fantasy</Genre><LanguageISO>fr</LanguageISO>'
          '<Summary>${'A long tale. ' * 400}</Summary></ComicInfo>',
        ),
        'issue/p10.png': _b('later'),
        'issue/p2.png': _png,
      });
      final metadata = await inspect(bytes);
      expect(metadata['title'], 'Saga #3');
      expect(metadata['author'], 'BKV');
      expect(metadata['language'], 'fr');
      // Deflated (the summary compresses), cut to the API's 4,000 limit.
      expect(metadata['description'], hasLength(4000));
      expect(metadata['subjects'], ['Comics', 'Space', 'Fantasy']);
      expect(metadata['coverBytes'], _png);
      expect(metadata['sha256'], sha256.convert(bytes).toString());
    });

    test('broken ComicInfo falls back to the file name', () async {
      final metadata = await inspect(
        _zip({'ComicInfo.xml': _b('<ComicInfo><Series>'), '1.jpg': _png}),
        'The_Long_Halloween.cbz',
      );
      expect(metadata['title'], 'The Long Halloween');
    });

    test('refuses what the API would reject', () async {
      await expectLater(
        inspect(_zip({'1.jpg': _png}, encrypt: true)),
        refusal('Password-protected'),
      );
      await expectLater(
        inspect(_zip({'notes.txt': _b('x')})),
        refusal('no page images'),
      );
      await expectLater(
        inspect(_zip({'1.jpg': _png, '../x.txt': _b('x')})),
        refusal('unsafe file names'),
      );
      await expectLater(
        inspect(_zip({'1.jpg': _png, '/1.jpg': _png})),
        refusal('duplicate'),
      );
      await expectLater(
        inspect(_b('PK\x03\x04 truncated')),
        refusal('damaged'),
      );
    });
  });

  test(
    'a comic imports locally and uploads with its format and media type',
    () async {
      final source = File('${temp.path}/Vector.cbr')..writeAsBytesSync(_rar5);
      final work = await Directory('${temp.path}/work').create();
      final cbz = await prepareComic(
        source.path,
        work,
        extract: _fakeRar(_vector),
      );
      final cbzFile = File('${temp.path}/Vector.cbz');
      await File(cbz).copy(cbzFile.path);

      final requests = <http.Request>[];
      final client = ApiClient(baseUrl: 'https://books.example');
      final library = LibraryRepository(
        store: MemoryKeyValueStore(),
        bookStore: IoBookStore(Directory('${temp.path}/books')),
      );
      await library.load();
      Book? published;
      final service = EpubImportService(
        bookStore: IoBookStore(Directory('${temp.path}/books')),
        library: library,
        store: MemoryKeyValueStore(),
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (origin) => UploadApi(
          origin,
          client: MockClient((request) async {
            requests.add(request);
            if (request.url.path == '/v1/uploads/prepare') {
              final body = jsonDecode(request.body) as Map<String, dynamic>;
              published = Book.fromJson({
                ...body,
                'id': 'comic-${body['sha256']}',
                'version': (body['sha256'] as String).substring(0, 12),
                'downloadUrl': '/v1/books/comic-${body['sha256']}/download',
                'coverUrl': null,
                'updatedAt': '2026-10-11T00:00:00Z',
              });
              return http.Response(
                jsonEncode({
                  'book': published!.toJson(),
                  'uploaded': false,
                  'uploadUrl': '/v1/uploads/${body['sha256']}',
                }),
                200,
              );
            }
            return http.Response(
              jsonEncode({'book': published!.toJson(), 'uploaded': true}),
              200,
            );
          }),
        ),
      );
      addTearDown(() {
        service.dispose();
        library.dispose();
        client.close();
      });

      final entry = (await service.importPath(cbzFile.path))!;
      expect(service.error, isNull);
      expect(entry.book.id, 'comic-$_vectorSha');
      expect(entry.book.isComic, isTrue);
      expect(entry.book.title, 'Vector');
      expect(entry.download.isReady, isTrue);
      // Readable from the local copy straight away.
      final file = await library.openForReading(entry.id);
      expect(file.isProvisional, isFalse);
      expect(file.length, 794);
      await file.close();

      await service.retryPending();
      final prepare = jsonDecode(requests.first.body) as Map<String, dynamic>;
      expect(prepare, {
        'format': 'comic',
        'sha256': _vectorSha,
        'fileSize': 794,
        'title': 'Vector',
        'author': 'Unknown',
        'description': '',
        'language': 'en',
        'subjects': ['Comics'],
      });
      final put = requests.last;
      expect(put.method, 'PUT');
      expect(put.headers['content-type'], 'application/vnd.comicbook+zip');
      expect(sha256.convert(put.bodyBytes).toString(), _vectorSha);
      expect(service.pendingCount, 0);
    },
  );
}
