import 'dart:io';
import 'dart:typed_data';

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
  });

  test('rejects a non-EPUB file honestly', () async {
    await expectLater(
      EpubPackage.open(_BytesFile(Uint8List.fromList(List.filled(100, 7)))),
      throwsA(isA<EpubFormatException>()),
    );
  });
}
