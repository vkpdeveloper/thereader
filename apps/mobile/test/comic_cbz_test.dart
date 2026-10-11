import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/comic/cbz_writer.dart';
import 'package:thereader/data/comic/comic_info.dart';

List<int> _b(String latin1Text) => latin1.encode(latin1Text);

/// docs/comics.md, "Reference vector".
final _vector = <String, List<int>>{
  'Comic/ComicInfo.xml': utf8.encode(
    '<?xml version="1.0"?><ComicInfo><Series>Vector</Series></ComicInfo>',
  ),
  'Comic/page10.jpg': _b('\xff\xd8\xff ten'),
  'Comic/page2.JPG': _b('\xff\xd8\xff two'),
  'Comic/page02b.png': _b('\x89PNG two-b'),
  'Comic/Cover.webp': _b('RIFF cover'),
  'Comic/__MACOSX/._page2.jpg': _b('junk'),
  'Comic/.hidden.jpg': _b('hidden'),
  'Comic/notes.txt': _b('notes'),
  'Comic/extras/001.jpg': _b('\xff\xd8\xff extra'),
};

List<CbzSource> _sources(Map<String, List<int>> entries, {int split = 3}) => [
  for (final MapEntry(key: name, value: bytes) in entries.entries)
    CbzSource(
      name: name,
      size: bytes.length,
      // Several chunks per entry exercise the incremental CRC and SHA.
      open: () => Stream.fromIterable([
        for (var i = 0; i < bytes.length; i += split)
          bytes.sublist(i, i + split < bytes.length ? i + split : bytes.length),
      ]),
    ),
];

Future<(Uint8List, CbzResult)> _pack(Map<String, List<int>> entries) async {
  final out = BytesBuilder();
  final result = await writeDeterministicCbz(
    _sources(entries),
    (bytes) async => out.add(bytes),
  );
  return (out.takeBytes(), result);
}

void main() {
  group('deterministic repack', () {
    test('reproduces the contract reference vector', () async {
      final (bytes, result) = await _pack(_vector);
      expect(bytes.length, 794);
      expect(result.size, 794);
      expect(
        sha256.convert(bytes).toString(),
        'f425a5b825fd0263e84f6a9106d6ca08e240adb2982c0007e4c644835dace109',
      );
      expect(result.sha256, sha256.convert(bytes).toString());
      expect(result.pages, [
        'Comic/Cover.webp',
        'Comic/extras/001.jpg',
        'Comic/page2.JPG',
        'Comic/page02b.png',
        'Comic/page10.jpg',
      ]);
      expect(result.comicInfo, 'Comic/ComicInfo.xml');
    });

    test('the output is a valid stored ZIP with the original bytes', () async {
      final (bytes, _) = await _pack(_vector);
      final archive = ZipDecoder().decodeBytes(bytes);
      expect(archive.files.map((f) => f.name), [
        'Comic/Cover.webp',
        'Comic/extras/001.jpg',
        'Comic/page2.JPG',
        'Comic/page02b.png',
        'Comic/page10.jpg',
        'Comic/ComicInfo.xml',
      ]);
      for (final file in archive.files) {
        expect(file.compression, CompressionType.none);
        expect(file.content, _vector[file.name]);
      }
    });

    test('is independent of input order and chunking', () async {
      final reversed = Map.fromEntries(_vector.entries.toList().reversed);
      final out = BytesBuilder();
      await writeDeterministicCbz(
        _sources(reversed, split: 1),
        (b) async => out.add(b),
      );
      final (bytes, _) = await _pack(_vector);
      expect(out.takeBytes(), bytes);
    });

    test('keeps the shallowest ComicInfo.xml', () async {
      final (_, result) = await _pack({
        'a/b/ComicInfo.xml': [1],
        'z/comicinfo.XML': [2],
        'p1.png': [3],
      });
      expect(result.comicInfo, 'z/comicinfo.XML');
    });

    test('refuses archives without pages, duplicates and oversize', () async {
      await expectLater(
        _pack({
          'notes.txt': [1],
        }),
        throwsA(isA<FormatException>()),
      );
      await expectLater(
        writeDeterministicCbz([
          CbzSource(name: 'a.jpg', size: 1, open: () => Stream.value([1])),
          CbzSource(name: 'a.jpg', size: 1, open: () => Stream.value([2])),
        ], (_) async {}),
        throwsA(isA<FormatException>()),
      );
      await expectLater(
        writeDeterministicCbz(
          _sources({'a.jpg': List.filled(100, 1)}),
          (_) async {},
          maxBytes: 99,
        ),
        throwsA(isA<FormatException>()),
      );
      // A source whose length differs from what it declared.
      await expectLater(
        writeDeterministicCbz([
          CbzSource(name: 'a.jpg', size: 3, open: () => Stream.value([1])),
        ], (_) async {}),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('magic bytes', () {
    test('identify comic archives regardless of extension', () {
      expect(sniffComicArchive([0x50, 0x4b, 3, 4, 0]), ComicArchiveKind.zip);
      expect(sniffComicArchive([0x50, 0x4b, 5, 6]), ComicArchiveKind.zip);
      expect(
        sniffComicArchive(_b('Rar!\x1a\x07\x00\xcf')),
        ComicArchiveKind.rar,
      );
      expect(
        sniffComicArchive(_b('Rar!\x1a\x07\x01\x00\x33')),
        ComicArchiveKind.rar,
      );
      expect(
        sniffComicArchive(_b('Rar!\x1a\x07\x02')),
        ComicArchiveKind.unknown,
      );
      expect(
        sniffComicArchive([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
        ComicArchiveKind.sevenZip,
      );
      expect(sniffComicArchive(_b('%PDF-1.7')), ComicArchiveKind.pdf);
      final tar = List.filled(512, 0)
        ..setRange(257, 262, ascii.encode('ustar'));
      expect(sniffComicArchive(tar), ComicArchiveKind.tar);
      expect(sniffComicArchive(const []), ComicArchiveKind.unknown);
      for (final kind in [
        ComicArchiveKind.sevenZip,
        ComicArchiveKind.tar,
        ComicArchiveKind.pdf,
      ]) {
        expect(unsupportedComicMessage(kind), isNotEmpty);
      }
    });
  });

  group('ComicInfo.xml', () {
    test('composes Series #Number: Title and maps the fields', () {
      final meta = comicMetadata(
        fileName: 'ignored.cbr',
        comicInfoXml: '''<?xml version="1.0"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>The Long Night</Title>
  <Series>Jack  Hawk</Series>
  <Number>3</Number>
  <Summary>A pulp
  adventure.</Summary>
  <Writer>Ann Author</Writer>
  <Penciller>Pen Ciller</Penciller>
  <Genre>Adventure, Crime,Adventure, </Genre>
  <LanguageISO>fr</LanguageISO>
</ComicInfo>''',
      );
      expect(meta, {
        'title': 'Jack Hawk #3: The Long Night',
        'author': 'Ann Author',
        'description': 'A pulp adventure.',
        'language': 'fr',
        'subjects': ['Comics', 'Adventure', 'Crime'],
      });
    });

    test('falls back field by field', () {
      Map<String, dynamic> meta(String body) => comicMetadata(
        fileName: 'x.cbz',
        comicInfoXml: '<ComicInfo>$body</ComicInfo>',
      );
      expect(meta('<Series>S</Series>')['title'], 'S');
      expect(meta('<Series>S</Series><Number>1</Number>')['title'], 'S #1');
      expect(meta('<Series>S</Series><Title>T</Title>')['title'], 'S: T');
      expect(meta('<Title>T</Title><Number>9</Number>')['title'], 'T');
      expect(meta('<Penciller>P</Penciller>')['author'], 'P');
      expect(meta('')['author'], 'Unknown');
      expect(meta('<LanguageISO>not a tag!</LanguageISO>')['language'], 'en');
      expect(meta('')['subjects'], ['Comics']);
      expect(meta('')['description'], '');
      expect(meta('')['title'], 'x');
    });

    test('uses the file name without ComicInfo or for broken XML', () {
      expect(
        comicMetadata(fileName: '/tmp/Jack_Hawk_01.cbr')['title'],
        'Jack Hawk 01',
      );
      expect(
        comicMetadata(
          fileName: 'a.cbz',
          comicInfoXml: '<ComicInfo><Series>',
        )['title'],
        'a',
      );
      expect(
        comicMetadata(
          fileName: 'b.cbz',
          comicInfoXml:
              '<!DOCTYPE x [<!ENTITY e "boom">]><ComicInfo><Series>&e;</Series></ComicInfo>',
        )['title'],
        'b',
      );
      expect(titleFromFileName('__.cbz'), 'Untitled');
    });

    test('caps subjects at 32', () {
      final genres = List.generate(40, (i) => 'g$i').join(',');
      final meta = comicMetadata(
        fileName: 'a.cbz',
        comicInfoXml: '<ComicInfo><Genre>$genres</Genre></ComicInfo>',
      );
      expect(meta['subjects'], hasLength(32));
      expect((meta['subjects'] as List).first, 'Comics');
    });
  });
}
