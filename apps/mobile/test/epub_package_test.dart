import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/dart_engine/epub_package.dart';

class _BytesFile implements BookFile {
  _BytesFile(this.bytes);
  final Uint8List bytes;
  @override
  int get length => bytes.length;
  @override
  String? get path => null;
  @override
  Future<Uint8List> readAll() async => bytes;
  @override
  Future<Uint8List> readRange(int start, int end) async => bytes.sublist(start, end);
  @override
  Future<void> close() async {}
}

void main() {
  test('parses the bundled sample package: metadata, spine, toc, resources', () async {
    final bytes = File('assets/samples/the-quiet-hour.epub').readAsBytesSync();
    final pkg = await EpubPackage.open(_BytesFile(bytes));
    expect(pkg.info.title, 'The Quiet Hour');
    expect(pkg.info.author, 'The Reader');
    expect(pkg.spine.length, 3);
    expect(pkg.spine.first.href, 'OEBPS/chapter-1.xhtml');
    expect(pkg.info.toc.map((t) => t.title), ['Before the Kettle', 'The Shape of a Page', 'What the Hour Is For']);
    expect(pkg.info.toc.first.href, 'OEBPS/chapter-1.xhtml');
    expect(pkg.readText('OEBPS/chapter-2.xhtml'), contains('A page is a room with two walls'));
    expect(pkg.resolve('OEBPS/chapter-1.xhtml', '../images/a.png'), 'images/a.png');
    expect(pkg.spineItemFor('OEBPS/chapter-3.xhtml#top')?.index, 2);
    // A malformed escape in a book's src names nothing rather than throwing.
    expect(pkg.resolve('OEBPS/chapter-1.xhtml', 'eq%zz.png'), 'OEBPS/eq%zz.png');
    expect(pkg.readBytes(pkg.resolve('OEBPS/chapter-1.xhtml', 'eq%zz.png')), isNull);
  });

  test('an entry that inflates past the limit reads as missing, even with forged sizes', () async {
    final sample = ZipDecoder().decodeBytes(File('assets/samples/the-quiet-hour.epub').readAsBytesSync());
    final archive = Archive();
    for (final f in sample.files) {
      archive.addFile(ArchiveFile.bytes(f.name, f.content));
    }
    archive.addFile(ArchiveFile.bytes('OEBPS/bomb.png', Uint8List(EpubPackage.maxEntryBytes + 1)));
    final bytes = Uint8List.fromList(ZipEncoder().encodeBytes(archive));
    // Claim 1 KB in both headers: the cap must hold while inflating.
    final view = ByteData.sublistView(bytes);
    for (var i = 0; i + 4 <= bytes.length; i++) {
      final sig = view.getUint32(i, Endian.little);
      final name = sig == 0x04034b50 ? i + 30 : sig == 0x02014b50 ? i + 46 : -1;
      if (name < 0 || name + 14 > bytes.length) continue;
      if (String.fromCharCodes(bytes.sublist(name, name + 14)) != 'OEBPS/bomb.png') continue;
      view.setUint32(sig == 0x04034b50 ? i + 22 : i + 24, 1024, Endian.little);
    }
    final pkg = await EpubPackage.open(_BytesFile(bytes));
    expect(pkg.readBytes('OEBPS/bomb.png'), isNull);
    expect(pkg.readText('OEBPS/chapter-2.xhtml'), contains('A page is a room with two walls'));
  });

  test('rejects a non-EPUB file honestly', () async {
    await expectLater(
      EpubPackage.open(_BytesFile(Uint8List.fromList(List.filled(100, 7)))),
      throwsA(isA<EpubFormatException>()),
    );
  });
}
