import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;
import 'package:xml/xml.dart';

import '../../data/storage/book_store.dart';
import '../engine/reader_engine.dart';
import 'zip_opener_stub.dart'
    if (dart.library.io) 'zip_opener_io.dart'
    if (dart.library.js_interop) 'zip_opener_web.dart'
    as zip;

class EpubFormatException implements Exception {
  EpubFormatException(this.message);
  final String message;
  @override
  String toString() => message;
}

class SpineItem {
  const SpineItem({
    required this.idref,
    required this.href,
    required this.mediaType,
    required this.index,
  });
  final String idref;

  /// Path inside the zip, normalised (e.g. `OEBPS/chapter-1.xhtml`).
  final String href;
  final String mediaType;
  final int index;
}

/// Minimal but real EPUB 2/3 package reader: container.xml -> OPF -> manifest,
/// spine, nav/NCX table of contents. Entries are decompressed on demand so a
/// 70 MB book with images does not get inflated into memory at once.
class EpubPackage {
  EpubPackage._(this._archive, this.opfPath, this.info, this.spine, this._manifestByHref);

  final Archive _archive;
  final String opfPath;
  final PublicationInfo info;
  final List<SpineItem> spine;
  final Map<String, String> _manifestByHref; // href -> media type

  String get opfDir => p.posix.dirname(opfPath) == '.' ? '' : p.posix.dirname(opfPath);

  static Future<EpubPackage> open(BookFile file) async {
    // On native the zip is indexed from disk and entries inflate on demand;
    // on web the session bytes are used directly.
    final Archive archive;
    try {
      archive = await zip.openArchive(file);
    } catch (e) {
      throw EpubFormatException('This file is not a valid EPUB (zip) container.');
    }

    try {
      final container = _readText(archive, 'META-INF/container.xml');
      if (container == null) throw EpubFormatException('Missing META-INF/container.xml.');
      final containerDoc = XmlDocument.parse(container);
      final rootfile = containerDoc.findAllElements('rootfile').firstOrNull;
      final opfPath = _normalize(rootfile?.getAttribute('full-path') ?? '');
      if (opfPath.isEmpty) throw EpubFormatException('container.xml has no rootfile.');

      final opfText = _readText(archive, opfPath);
      if (opfText == null) throw EpubFormatException('Package document $opfPath not found.');
      final opf = XmlDocument.parse(opfText);
      final pkg = opf.rootElement;
      final opfDir = p.posix.dirname(opfPath) == '.' ? '' : p.posix.dirname(opfPath);

      String dc(String name) =>
          pkg.findAllElements(name, namespaceUri: '*').firstOrNull?.innerText.trim() ?? '';

      final manifestById = <String, (String href, String mediaType, String properties)>{};
      final manifestByHref = <String, String>{};
      for (final item in pkg.findAllElements('item', namespaceUri: '*')) {
        final id = item.getAttribute('id') ?? '';
        final href = _normalize(
          p.posix.join(opfDir, Uri.decodeComponent(item.getAttribute('href') ?? '')),
        );
        final type = item.getAttribute('media-type') ?? '';
        manifestById[id] = (href, type, item.getAttribute('properties') ?? '');
        manifestByHref[href] = type;
      }

      final spine = <SpineItem>[];
      final spineEl = pkg.findAllElements('spine', namespaceUri: '*').firstOrNull;
      for (final ref
          in spineEl?.findElements('itemref', namespaceUri: '*') ?? const <XmlElement>[]) {
        if (ref.getAttribute('linear') == 'no') continue;
        final idref = ref.getAttribute('idref') ?? '';
        final m = manifestById[idref];
        if (m == null) continue;
        spine.add(SpineItem(idref: idref, href: m.$1, mediaType: m.$2, index: spine.length));
      }
      if (spine.isEmpty) throw EpubFormatException('The book has no readable spine items.');

      // Table of contents: EPUB 3 nav document, else EPUB 2 NCX.
      var toc = <TocEntry>[];
      final navItem = manifestById.values.where((m) => m.$3.split(' ').contains('nav')).firstOrNull;
      if (navItem != null) {
        final navText = _readText(archive, navItem.$1);
        if (navText != null) toc = _parseNav(navText, p.posix.dirname(navItem.$1));
      }
      if (toc.isEmpty) {
        final ncxId = spineEl?.getAttribute('toc');
        final ncx = ncxId != null ? manifestById[ncxId] : null;
        final ncxItem =
            ncx ?? manifestById.values.where((m) => m.$2 == 'application/x-dtbncx+xml').firstOrNull;
        if (ncxItem != null) {
          final ncxText = _readText(archive, ncxItem.$1);
          if (ncxText != null) toc = _parseNcx(ncxText, p.posix.dirname(ncxItem.$1));
        }
      }
      if (toc.isEmpty) {
        toc = [for (final s in spine) TocEntry(title: 'Section ${s.index + 1}', href: s.href)];
      }

      final info = PublicationInfo(
        title: dc('title').isEmpty ? 'Untitled' : dc('title'),
        author: dc('creator'),
        language: dc('language').isEmpty ? null : dc('language'),
        spineCount: spine.length,
        toc: toc,
      );
      await file.close();
      return EpubPackage._(archive, opfPath, info, spine, manifestByHref);
    } catch (_) {
      await zip.closeArchive(archive);
      rethrow;
    }
  }

  Future<void> close() => zip.closeArchive(_archive);

  /// Raw bytes of a resource by normalised zip path, or null (also when it
  /// inflates past [maxEntryBytes]).
  Uint8List? readBytes(String href) => _inflate(_archive, href);

  String? readText(String href) {
    final b = readBytes(href);
    return b == null ? null : utf8.decode(b, allowMalformed: true);
  }

  String? mediaTypeOf(String href) => _manifestByHref[_normalize(href)];

  /// Resolves a relative reference from inside [fromHref] to a zip path.
  String resolve(String fromHref, String relative) {
    final clean = relative.split('#').first.split('?').first;
    if (clean.isEmpty) return _normalize(fromHref);
    final base = p.posix.dirname(fromHref);
    String decoded;
    try {
      decoded = Uri.decodeComponent(clean);
    } on ArgumentError {
      decoded = clean; // A malformed escape: names nothing, found nowhere.
    }
    return _normalize(p.posix.join(base == '.' ? '' : base, decoded));
  }

  SpineItem? spineItemFor(String href) {
    final target = _normalize(href.split('#').first);
    for (final s in spine) {
      if (s.href == target) return s;
    }
    return null;
  }

  static String? _readText(Archive a, String path) {
    final b = _inflate(a, path);
    return b == null ? null : utf8.decode(b, allowMalformed: true);
  }

  /// Largest resource inflated, as in the Readium copy's rewriter: a small
  /// entry in a hostile book can claim (or secretly hold) gigabytes.
  static const maxEntryBytes = 64 << 20;

  /// Inflates into a capped buffer, so a forged size in the zip headers
  /// cannot get past the limit either. Nothing is cached on the entry.
  static Uint8List? _inflate(Archive a, String path) {
    final f = a.findFile(_normalize(path));
    if (f == null || f.size > maxEntryBytes) return null;
    final out = _CappedOutput(maxEntryBytes);
    try {
      f.writeContent(out);
    } on _TooLarge {
      return null;
    }
    return out.getBytes();
  }

  static String _normalize(String path) {
    var s = path.replaceAll('\\', '/');
    while (s.startsWith('/')) {
      s = s.substring(1);
    }
    return p.posix.normalize(s) == '.' ? '' : p.posix.normalize(s);
  }

  static List<TocEntry> _parseNav(String xml, String baseDir) {
    final out = <TocEntry>[];
    try {
      final doc = XmlDocument.parse(xml);
      XmlElement? nav;
      for (final n in doc.findAllElements('nav', namespaceUri: '*')) {
        final type = n.attributes
            .where((a) => a.name.local == 'type')
            .map((a) => a.value)
            .firstOrNull;
        if (type == 'toc') {
          nav = n;
          break;
        }
      }
      nav ??= doc.findAllElements('nav', namespaceUri: '*').firstOrNull;
      if (nav == null) return out;
      void walk(XmlElement ol, int depth) {
        for (final li in ol.findElements('li', namespaceUri: '*')) {
          final a = li.findElements('a', namespaceUri: '*').firstOrNull;
          final href = a?.getAttribute('href');
          final title =
              (a?.innerText ??
                      li.findElements('span', namespaceUri: '*').firstOrNull?.innerText ??
                      '')
                  .replaceAll(RegExp(r'\s+'), ' ')
                  .trim();
          if (href != null && title.isNotEmpty) {
            out.add(
              TocEntry(
                title: title,
                href: _normalize(
                  p.posix.join(baseDir == '.' ? '' : baseDir, Uri.decodeComponent(href)),
                ),
                depth: depth,
              ),
            );
          }
          for (final sub in li.findElements('ol', namespaceUri: '*')) {
            walk(sub, depth + 1);
          }
        }
      }

      for (final ol in nav.findElements('ol', namespaceUri: '*')) {
        walk(ol, 0);
      }
    } catch (_) {}
    return out;
  }

  static List<TocEntry> _parseNcx(String xml, String baseDir) {
    final out = <TocEntry>[];
    try {
      final doc = XmlDocument.parse(xml);
      void walk(XmlElement parent, int depth) {
        for (final np in parent.findElements('navPoint', namespaceUri: '*')) {
          final label =
              np
                  .findElements('navLabel', namespaceUri: '*')
                  .firstOrNull
                  ?.findElements('text', namespaceUri: '*')
                  .firstOrNull
                  ?.innerText
                  .trim() ??
              '';
          final src = np
              .findElements('content', namespaceUri: '*')
              .firstOrNull
              ?.getAttribute('src');
          if (src != null && label.isNotEmpty) {
            out.add(
              TocEntry(
                title: label,
                href: _normalize(
                  p.posix.join(baseDir == '.' ? '' : baseDir, Uri.decodeComponent(src)),
                ),
                depth: depth,
              ),
            );
          }
          walk(np, depth + 1);
        }
      }

      final map = doc.findAllElements('navMap', namespaceUri: '*').firstOrNull;
      if (map != null) walk(map, 0);
    } catch (_) {}
    return out;
  }
}

class _TooLarge implements Exception {
  const _TooLarge();
}

/// Fails as soon as the inflated output passes [cap].
class _CappedOutput extends OutputMemoryStream {
  _CappedOutput(this.cap);

  final int cap;

  void _grow(int more) {
    if (length + more > cap) throw const _TooLarge();
  }

  @override
  void writeByte(int value) {
    _grow(1);
    super.writeByte(value);
  }

  @override
  void writeBytes(List<int> bytes, {int? length}) {
    _grow(length ?? bytes.length);
    super.writeBytes(bytes, length: length);
  }

  @override
  void writeStream(InputStream stream) {
    _grow(stream.length);
    super.writeStream(stream);
  }

  @override
  void writeBackReference(int distance, int count) {
    _grow(count);
    super.writeBackReference(distance, count);
  }
}
