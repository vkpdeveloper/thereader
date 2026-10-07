import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:thereader/reader/enhance/enhanced_epub.dart';
import 'package:thereader/reader/enhance/epub_rewrite.dart';

final _bundle = {
  'enhance.css': Uint8List.fromList(utf8.encode('pre { white-space: pre; }')),
  'enhance.js': Uint8List.fromList(
    utf8.encode('globalThis.TheReaderEnhance = {};'),
  ),
};

const _opf = '''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata/>
  <manifest>
    <item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="top.html" media-type="text/html"/>
    <item id="img" href="Images/eq.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>''';

const _chapter = '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch — 1</title>
<link rel="stylesheet" href="../Styles/a.css"/></HEAD>
<body><p>Café ∑ <img src="../Images/eq.png" alt="x^2"/></p></body></html>''';

Uint8List _epub({String opf = _opf, String chapter = _chapter}) {
  final archive = Archive()
    ..add(
      ArchiveFile.bytes('mimetype', ascii.encode('application/epub+zip'))
        ..compression = CompressionType.none,
    )
    ..add(
      ArchiveFile.string(
        'META-INF/container.xml',
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
            '</rootfiles></container>',
      ),
    )
    ..add(ArchiveFile.string('OEBPS/content.opf', opf))
    ..add(ArchiveFile.bytes('OEBPS/Text/chapter 1.xhtml', utf8.encode(chapter)))
    ..add(
      ArchiveFile.string(
        'OEBPS/top.html',
        '<html><body><pre>x</pre></body></html>',
      ),
    )
    ..add(
      ArchiveFile.bytes(
        'OEBPS/Images/eq.png',
        List.generate(5000, (i) => i * 7 % 251),
      ),
    );
  return ZipEncoder().encodeBytes(archive);
}

Map<String, Uint8List> _read(String path) {
  final archive = ZipDecoder().decodeBytes(
    File(path).readAsBytesSync(),
    verify: true,
  );
  return {
    for (final f in archive.files)
      if (f.isFile) f.name: f.content,
  };
}

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('enhance'));
  tearDown(() => dir.delete(recursive: true));

  test('links the bundle into every document and keeps every original entry', () {
    final source = p.join(dir.path, 'book.epub');
    File(source).writeAsBytesSync(_epub());
    final target = p.join(dir.path, 'out.epub');
    final stats = rewriteEpubWithEnhancer(
      source: source,
      target: target,
      bundle: _bundle,
    );
    expect(stats.documents, 2);

    final before = _read(source);
    final after = _read(target);
    expect(after.keys, containsAll(before.keys));
    expect(after.keys.first, 'mimetype');
    expect(after['OEBPS/Images/eq.png'], before['OEBPS/Images/eq.png']);
    expect(after['OEBPS/__thereader/enhance.js'], _bundle['enhance.js']);
    expect(after['OEBPS/__thereader/enhance.css'], _bundle['enhance.css']);

    final chapter = utf8.decode(after['OEBPS/Text/chapter 1.xhtml']!);
    expect(
      chapter,
      contains(
        '<link rel="stylesheet" type="text/css" href="../__thereader/enhance.css"/>'
        '<script type="text/javascript" src="../__thereader/enhance.js"></script></HEAD>',
      ),
    );
    // Non-ASCII text is untouched byte for byte.
    expect(
      chapter.replaceAll(
        RegExp(
          r'<link rel="stylesheet" type="text/css" href="\.\./__thereader[^>]*>|<script[^>]*></script>',
        ),
        '',
      ),
      _chapter,
    );
    expect(
      utf8.decode(after['OEBPS/top.html']!),
      contains(
        '<head><link rel="stylesheet" type="text/css" href="__thereader/enhance.css"/>',
      ),
    );

    final opf = utf8.decode(after['OEBPS/content.opf']!);
    expect(
      opf,
      contains(
        '<item id="thereader-enhance-0" href="__thereader/enhance.css" media-type="text/css"/>',
      ),
    );
    expect(
      opf,
      contains(
        '<item id="thereader-enhance-1" href="__thereader/enhance.js" media-type="application/javascript"/>',
      ),
    );
    expect(opf, contains('<spine><itemref idref="c1"/>'));
  });

  test('mimetype stays first and stored', () {
    final source = p.join(dir.path, 'book.epub');
    File(source).writeAsBytesSync(_epub());
    final target = p.join(dir.path, 'out.epub');
    rewriteEpubWithEnhancer(source: source, target: target, bundle: _bundle);
    final bytes = File(target).readAsBytesSync();
    expect(bytes.sublist(0, 4), [0x50, 0x4b, 0x03, 0x04]);
    expect(bytes[8] | bytes[9] << 8, 0, reason: 'stored');
    expect(ascii.decode(bytes.sublist(30, 38)), 'mimetype');
    expect(ascii.decode(bytes.sublist(38, 58)), 'application/epub+zip');
  });

  test(
    'rewriting a derived copy replaces its bundle instead of doubling it',
    () {
      final source = p.join(dir.path, 'book.epub');
      File(source).writeAsBytesSync(_epub());
      final once = p.join(dir.path, 'once.epub');
      final twice = p.join(dir.path, 'twice.epub');
      rewriteEpubWithEnhancer(source: source, target: once, bundle: _bundle);
      final stats = rewriteEpubWithEnhancer(
        source: once,
        target: twice,
        bundle: _bundle,
      );
      expect(stats.documents, 0);
      final names = ZipDecoder()
          .decodeBytes(File(twice).readAsBytesSync())
          .files
          .map((f) => f.name);
      expect(names.where((n) => n.contains('__thereader')), hasLength(2));
    },
  );

  test('prefixed OPF manifests get prefixed items', () {
    final source = p.join(dir.path, 'book.epub');
    final opf = _opf
        .replaceAll('<manifest>', '<opf:manifest>')
        .replaceAll('</manifest>', '</opf:manifest>')
        .replaceAll('<item ', '<opf:item ')
        .replaceAll(
          '<package xmlns=',
          '<package xmlns:opf="http://www.idpf.org/2007/opf" xmlns=',
        );
    File(source).writeAsBytesSync(_epub(opf: opf));
    final target = p.join(dir.path, 'out.epub');
    expect(
      rewriteEpubWithEnhancer(
        source: source,
        target: target,
        bundle: _bundle,
      ).documents,
      2,
    );
    expect(
      utf8.decode(_read(target)['OEBPS/content.opf']!),
      contains('<opf:item id="thereader-enhance-1"'),
    );
  });

  group('injectEnhancer', () {
    Uint8List b(String s) => Uint8List.fromList(utf8.encode(s));
    String? run(String s) {
      final out = injectEnhancer(
        b(s),
        stylesheets: ['e.css'],
        scripts: ['e.js'],
      );
      return out == null ? null : utf8.decode(out);
    }

    test('fills an empty head', () {
      expect(
        run('<html><head/><body/></html>'),
        '<html><head><link rel="stylesheet" type="text/css" href="e.css"/><script type="text/javascript" src="e.js"></script></head><body/></html>',
      );
    });
    test('adds a head before the body when there is none', () {
      expect(
        run('<html><body>x</body></html>'),
        startsWith('<html><head><link'),
      );
    });
    test('leaves documents without a head or body alone', () {
      expect(run('<svg/>'), isNull);
    });
  });

  group('EnhancedEpubCache', () {
    test('builds once, reuses, and prunes copies of older bundles', () async {
      final source = p.join(dir.path, '1-abc.epub');
      File(source).writeAsBytesSync(_epub());
      final first = await EnhancedEpubCache.resolve(
        source,
        bundle: EnhancerBundle(_bundle),
      );
      expect(first, isNot(source));
      expect(EnhancedEpubCache.isDerived(first), isTrue);
      final modified = File(first).statSync().modified;
      expect(
        await EnhancedEpubCache.resolve(
          source,
          bundle: EnhancerBundle(_bundle),
        ),
        first,
      );
      expect(File(first).statSync().modified, modified);

      final newer = EnhancerBundle({
        ..._bundle,
        'enhance.js': Uint8List.fromList(utf8.encode('v2')),
      });
      final second = await EnhancedEpubCache.resolve(source, bundle: newer);
      expect(second, isNot(first));
      expect(File(first).existsSync(), isFalse);
      expect(File(second).existsSync(), isTrue);
    });

    test(
      'prunes copies of a replaced book version but not of other books',
      () async {
        final other = p.join(dir.path, 'other.epub');
        File(other).writeAsBytesSync(_epub());
        final otherCopy = await EnhancedEpubCache.resolve(
          other,
          bundle: EnhancerBundle(_bundle),
        );
        final old = p.join(dir.path, '1-old.epub');
        File(old).writeAsBytesSync(_epub());
        final oldCopy = await EnhancedEpubCache.resolve(
          old,
          bundle: EnhancerBundle(_bundle),
        );
        File(old).deleteSync();
        final current = p.join(dir.path, '2-new.epub');
        File(current).writeAsBytesSync(_epub());
        await EnhancedEpubCache.resolve(
          current,
          bundle: EnhancerBundle(_bundle),
        );
        expect(File(oldCopy).existsSync(), isFalse);
        expect(File(otherCopy).existsSync(), isTrue);
      },
    );

    test(
      'falls back to the original file when the archive is unreadable',
      () async {
        final source = p.join(dir.path, 'broken.epub');
        File(source).writeAsBytesSync(utf8.encode('not a zip'));
        expect(
          await EnhancedEpubCache.resolve(
            source,
            bundle: EnhancerBundle(_bundle),
          ),
          source,
        );
        expect(dir.listSync().map((e) => p.basename(e.path)), ['broken.epub']);
      },
    );

    test('falls back when the file is missing', () async {
      final source = p.join(dir.path, 'missing.epub');
      expect(
        await EnhancedEpubCache.resolve(
          source,
          bundle: EnhancerBundle(_bundle),
        ),
        source,
      );
    });
  });

  // Local copies of real books (never committed). Skipped when absent.
  for (final name in ['nobs', 'llm', 'ladr3e']) {
    final book = File('/tmp/ladr/books/$name.epub');
    test('real book $name round-trips', () {
      final target = p.join(dir.path, '$name.epub');
      final stats = rewriteEpubWithEnhancer(
        source: book.path,
        target: target,
        bundle: _bundle,
      );
      final before = ZipDecoder().decodeBytes(book.readAsBytesSync());
      final after = ZipDecoder().decodeBytes(
        File(target).readAsBytesSync(),
        verify: true,
      );
      expect(after.files.length, before.files.length + 2);
      expect(stats.documents, greaterThan(0));
      // ignore: avoid_print
      print(
        '$name: $stats, ${book.lengthSync()} -> ${File(target).lengthSync()} bytes',
      );
    }, skip: book.existsSync() ? false : 'no local copy');
  }
}
