import 'dart:io';
import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/import/import_platform_io.dart';

void main() {
  test(
    'imports EPUB3, EPUB2, guide and conventional real cover paths only',
    () async {
      final temp = await Directory.systemTemp.createTemp('cover-import');
      addTearDown(() => temp.delete(recursive: true));
      final image = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0];
      for (final kind in ['epub3', 'epub2', 'guide', 'conventional', 'none']) {
        final zip = Archive();
        void add(String n, String v) => zip.add(ArchiveFile.string(n, v));
        add('mimetype', 'application/epub+zip');
        add(
          'META-INF/container.xml',
          '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
        );
        final id = kind == 'conventional' ? 'coverimage-standard' : 'image';
        add(
          'OEBPS/book.opf',
          '<package><metadata>${kind == 'epub2' ? '<meta name="cover" content="image"/>' : ''}</metadata><manifest><item id="c" href="c.xhtml"/><item id="$id" href="pic.png" ${kind == 'epub3' ? 'properties="cover-image"' : ''}/></manifest><spine><itemref idref="c"/></spine>${kind == 'guide' ? '<guide><reference type="cover" href="c.xhtml"/></guide>' : ''}</package>',
        );
        add('OEBPS/c.xhtml', '<html><body><img src="pic.png"/></body></html>');
        zip.add(ArchiveFile('OEBPS/pic.png', image.length, image));
        final f = File('${temp.path}/$kind.epub');
        await f.writeAsBytes(ZipEncoder().encode(zip));
        final result = await inspectEpub(f.path);
        expect(
          result['coverBytes'],
          kind == 'none' ? isNull : orderedEquals(image),
          reason: kind,
        );
      }
    },
  );
}
