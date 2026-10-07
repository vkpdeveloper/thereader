import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:thereader/reader/enhance/enhanced_epub.dart';
import 'package:thereader/reader/enhance/epub_rewrite.dart';

// Hostile and malformed archives: every one is refused with a
// FormatException (the caller then opens the original), never inflated into
// memory, copied into a corrupt derivative or allowed outside the book.

final _bundle = {
  'enhance.css': Uint8List.fromList(utf8.encode('pre{}')),
  'enhance.js': Uint8List.fromList(utf8.encode('void 0;')),
};

String _opf(Map<String, String> docs) =>
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>'
    '${[for (final (i, href) in docs.keys.indexed) '<item id="d$i" href="$href" media-type="application/xhtml+xml"/>'].join()}'
    '</manifest><spine/></package>';

/// [docs] maps manifest hrefs to zip names and bodies.
Uint8List _epub({
  String opfPath = 'OEBPS/content.opf',
  Map<String, (String, String)> docs = const {
    'a.xhtml': ('OEBPS/a.xhtml', '<html><head></head><body>a</body></html>'),
  },
  Map<String, String> extra = const {},
}) {
  final archive = Archive()
    ..add(
      ArchiveFile.bytes('mimetype', ascii.encode('application/epub+zip'))
        ..compression = CompressionType.none,
    )
    ..add(
      ArchiveFile.string(
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="$opfPath" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    )
    ..add(
      ArchiveFile.string(
        opfPath,
        _opf({for (final e in docs.entries) e.key: e.value.$1}),
      ),
    );
  for (final (name, body) in docs.values) {
    archive.add(ArchiveFile.string(name, body));
  }
  for (final e in extra.entries) {
    archive.add(ArchiveFile.string(e.key, e.value));
  }
  return ZipEncoder().encodeBytes(archive);
}

int _u16(List<int> b, int o) => b[o] | b[o + 1] << 8;
int _u32(List<int> b, int o) => _u16(b, o) | _u16(b, o + 2) << 16;
void _set32(List<int> b, int o, int v) {
  for (var i = 0; i < 4; i++) {
    b[o + i] = v >> (8 * i) & 0xff;
  }
}

/// Offsets of the central directory records in [zip].
List<int> _centralRecords(Uint8List zip) {
  final eocd = zip.length - 22;
  expect(_u32(zip, eocd), 0x06054b50);
  final out = <int>[];
  var pos = _u32(zip, eocd + 16);
  for (var i = 0; i < _u16(zip, eocd + 10); i++) {
    out.add(pos);
    pos += 46 + _u16(zip, pos + 28) + _u16(zip, pos + 30) + _u16(zip, pos + 32);
  }
  return out;
}

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('hostile'));
  tearDown(() => dir.delete(recursive: true));

  RewriteStats rewrite(
    Uint8List zip, {
    int maxEntryBytes = maxInflatedEntry,
    int maxTotalBytes = maxInflatedTotal,
  }) {
    final source = p.join(dir.path, 'book.epub');
    File(source).writeAsBytesSync(zip);
    return rewriteEpubWithEnhancer(
      source: source,
      target: p.join(dir.path, 'out.epub'),
      bundle: _bundle,
      maxEntryBytes: maxEntryBytes,
      maxTotalBytes: maxTotalBytes,
    );
  }

  Matcher refused(String message) => throwsA(
    isA<FormatException>().having(
      (e) => e.message,
      'message',
      contains(message),
    ),
  );

  test('a document that inflates past the entry limit is refused early', () {
    // About 1 KB of deflate for a megabyte of document.
    final bomb = '<html><head></head><body>${' ' * (1 << 20)}</body></html>';
    final zip = _epub(docs: {'a.xhtml': ('OEBPS/a.xhtml', bomb)});
    expect(zip.length, lessThan(16 << 10));
    expect(() => rewrite(zip, maxEntryBytes: 256 << 10), refused('size limit'));
    expect(File(p.join(dir.path, 'out.epub')).existsSync(), isFalse);
    expect(rewrite(zip).documents, 1, reason: 'within the default limits');
  });

  test('documents together may not inflate past the total limit', () {
    final body = '<html><head></head><body>${'x' * (100 << 10)}</body></html>';
    final zip = _epub(
      docs: {
        for (final n in ['a', 'b', 'c']) '$n.xhtml': ('OEBPS/$n.xhtml', body),
      },
    );
    expect(() => rewrite(zip, maxTotalBytes: 250 << 10), refused('size limit'));
    expect(rewrite(zip, maxTotalBytes: 400 << 10).documents, 3);
  });

  test('a central directory larger than the file is refused', () {
    final zip = _epub();
    _set32(zip, zip.length - 22 + 12, 0x7ffffff0);
    expect(() => rewrite(zip), refused('Corrupt central directory'));
  });

  test('entries sharing one local record are refused', () {
    final zip = _epub();
    final records = _centralRecords(zip);
    _set32(zip, records[2] + 42, _u32(zip, records[1] + 42));
    expect(() => rewrite(zip), refused('Overlapping entry'));
  });

  test('a local offset past the central directory is refused', () {
    final zip = _epub();
    final records = _centralRecords(zip);
    _set32(zip, records.last + 42, 0x7ffffff0);
    expect(() => rewrite(zip), refused('Overlapping entry'));
  });

  test('duplicate entry names are refused', () {
    final zip = _epub(extra: {'OEBPS/a.css': 'a{}', 'OEBPS/b.css': 'b{}'});
    final text = latin1.decode(zip);
    final central = text.lastIndexOf('OEBPS/b.css');
    zip[central + 'OEBPS/'.length] = 'a'.codeUnitAt(0);
    expect(() => rewrite(zip), refused('Duplicate entry'));
  });

  test('a package document outside the archive root is refused', () {
    for (final path in ['../content.opf', '/content.opf', r'OEBPS\..\x.opf']) {
      expect(
        () => rewrite(_epub(opfPath: path)),
        refused('Unsupported package path'),
        reason: path,
      );
    }
  });

  test('linked asset paths are percent-encoded', () {
    final zip = _epub(
      opfPath: 'OE BPS#1/content.opf',
      docs: {
        '../Text/c.xhtml': (
          'Text/c.xhtml',
          '<html><head></head><body>c</body></html>',
        ),
      },
    );
    expect(rewrite(zip).documents, 1);
    final out = ZipDecoder().decodeBytes(
      File(p.join(dir.path, 'out.epub')).readAsBytesSync(),
      verify: true,
    );
    final doc = utf8.decode(out.findFile('Text/c.xhtml')!.content);
    expect(doc, contains('href="../OE%20BPS%231/__thereader/enhance.css"'));
    expect(doc, contains('src="../OE%20BPS%231/__thereader/enhance.js"'));
    expect(out.findFile('OE BPS#1/__thereader/enhance.js'), isNotNull);
  });

  test('a malformed manifest href leaves that document alone', () {
    final zip = _epub(
      docs: {
        'a.xhtml': (
          'OEBPS/a.xhtml',
          '<html><head></head><body>a</body></html>',
        ),
        'b%zz.xhtml': (
          'OEBPS/b%zz.xhtml',
          '<html><head></head><body>b</body></html>',
        ),
      },
    );
    expect(rewrite(zip).documents, 1);
  });

  test(
    'a hostile book falls back to the original and leaves no partial copy',
    () async {
      final source = p.join(dir.path, 'book.epub');
      final zip = _epub();
      _set32(zip, zip.length - 22 + 12, 0x7ffffff0);
      File(source).writeAsBytesSync(zip);
      expect(
        await EnhancedEpubCache.resolve(
          source,
          bundle: EnhancerBundle(_bundle),
        ),
        source,
      );
      expect(dir.listSync().map((e) => p.basename(e.path)), ['book.epub']);
    },
  );

  test('partial copies left by a killed build are pruned', () async {
    final source = p.join(dir.path, 'book.epub');
    File(source).writeAsBytesSync(_epub());
    final stale = File(
      p.join(dir.path, 'book.enhanced-0123456789abcdef.epub.part'),
    )..writeAsStringSync('half');
    final orphan = File(
      p.join(dir.path, 'gone.enhanced-0123456789abcdef.epub.part'),
    )..writeAsStringSync('half');
    final derived = await EnhancedEpubCache.resolve(
      source,
      bundle: EnhancerBundle(_bundle),
    );
    expect(derived, isNot(source));
    expect(stale.existsSync(), isFalse);
    expect(orphan.existsSync(), isFalse);
  });
}
