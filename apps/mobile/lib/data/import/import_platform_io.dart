import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:archive/archive_io.dart';
import 'package:crypto/crypto.dart';
import 'package:file_picker/file_picker.dart';
import 'package:path/path.dart' as p;
import 'package:xml/xml.dart';

const maxImportBytes = 512 * 1024 * 1024;
bool get importSupported => true;
Stream<List<int>> readImportFile(String path) => File(path).openRead();

Future<String?> pickEpub() async {
  final picked = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: ['epub'],
  );
  if (picked == null) return null;
  if (!picked.name.toLowerCase().endsWith('.epub')) {
    throw const FormatException('Choose an EPUB file.');
  }
  final size = picked.lengthSync() ?? await picked.length();
  if (size != null && size > maxImportBytes) {
    throw const FormatException('EPUB imports are limited to 512 MiB.');
  }
  // File providers can return content URIs or temporary security-scoped URLs.
  // Consume their byte stream while the picker grants access, without readAll.
  final dir = await Directory.systemTemp.createTemp('thereader-import-');
  final file = File(p.join(dir.path, 'picked.epub'));
  final sink = file.openWrite();
  try {
    var count = 0;
    await for (final chunk in picked.readAsByteStream()) {
      count += chunk.length;
      if (count > maxImportBytes) {
        throw const FormatException('EPUB imports are limited to 512 MiB.');
      }
      sink.add(chunk);
      await sink.flush();
    }
    await sink.close();
    return file.path;
  } catch (_) {
    await sink.close();
    await dir.delete(recursive: true);
    rethrow;
  }
}

Future<void> cleanPickedEpub(String path) =>
    File(path).parent.delete(recursive: true);

Future<Map<String, dynamic>> inspectEpub(String path) =>
    Isolate.run(() => _inspect(path));

Future<Map<String, dynamic>> _inspect(String path) async {
  final file = File(path);
  final size = await file.length();
  if (size < 22) throw const FormatException('This file is not a valid EPUB.');
  if (size > maxImportBytes) {
    throw const FormatException('EPUB imports are limited to 512 MiB.');
  }
  final digest = await sha256.bind(file.openRead()).first;
  final input = InputFileStream(path);
  try {
    // Bound directory allocation before asking archive to parse local headers.
    // ZIP64/multidisk archives are unnecessary for the 512 MiB import limit.
    final tailStart = size > 65557 ? size - 65557 : 0;
    input.setPosition(tailStart);
    final tail = input.readBytes(size - tailStart).toUint8List();
    final view = ByteData.sublistView(tail);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (view.getUint32(i, Endian.little) == 0x06054b50 &&
          i + 22 + view.getUint16(i + 20, Endian.little) == tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw const FormatException('The EPUB ZIP directory is damaged.');
    }
    final entries = view.getUint16(eocd + 10, Endian.little);
    final dirSize = view.getUint32(eocd + 12, Endian.little);
    final dirOffset = view.getUint32(eocd + 16, Endian.little);
    if (entries == 0 ||
        entries > 50000 ||
        dirSize > 8 * 1024 * 1024 ||
        dirOffset + dirSize > tailStart + eocd ||
        view.getUint16(eocd + 4, Endian.little) != 0 ||
        view.getUint16(eocd + 6, Endian.little) != 0 ||
        view.getUint16(eocd + 8, Endian.little) != entries ||
        (eocd >= 20 &&
            view.getUint32(eocd - 20, Endian.little) == 0x07064b50)) {
      throw const FormatException(
        'This EPUB uses an unsupported ZIP directory.',
      );
    }
    input.setPosition(0);
    final directory = ZipDirectory()..read(input);
    if (directory.fileHeaders.length != entries) {
      throw const FormatException('The EPUB ZIP directory is damaged.');
    }
    final headers = <String, ZipFileHeader>{};
    for (final header in directory.fileHeaders) {
      if ((header.generalPurposeBitFlag & 1) != 0 ||
          ((header.file?.flags ?? 0) & 1) != 0) {
        throw const FormatException(
          'Encrypted or DRM-protected EPUBs are not supported.',
        );
      }
      if (headers.containsKey(header.filename)) {
        throw const FormatException('The EPUB contains duplicate ZIP entries.');
      }
      headers[header.filename] = header;
    }
    Uint8List read(String name, int limit) {
      final header = headers[name];
      if (header == null ||
          header.file == null ||
          header.uncompressedSize > limit ||
          header.compressedSize > limit ||
          ![0, 8].contains(header.compressionMethod)) {
        throw FormatException(
          'The EPUB has missing or oversized metadata: $name.',
        );
      }
      final output = _BoundedOutput(limit);
      header.file!.decompress(output);
      final bytes = output.getBytes();
      if (bytes.length != header.uncompressedSize ||
          getCrc32(bytes) != header.crc32) {
        throw const FormatException('The EPUB metadata is damaged.');
      }
      return bytes;
    }

    XmlDocument xml(String name, int limit) {
      final text = utf8.decode(read(name, limit));
      // EPUB 2 publishers commonly include external DTD declarations. They are
      // unnecessary for metadata extraction: remove them without resolving any
      // network resource. Internal subsets/custom entities remain unsupported.
      final withoutExternalDtd = text.replaceAll(
        RegExp(r'<!DOCTYPE\s+[^>\[]*>'),
        '',
      );
      if (withoutExternalDtd.contains('<!DOCTYPE') ||
          text.contains('<!ENTITY')) {
        throw const FormatException(
          'External XML declarations are not supported in EPUB metadata.',
        );
      }
      return XmlDocument.parse(withoutExternalDtd);
    }

    if (utf8.decode(read('mimetype', 64)).trim() != 'application/epub+zip') {
      throw const FormatException('This file is not an EPUB publication.');
    }
    if (headers.containsKey('META-INF/encryption.xml')) {
      final encryption = xml('META-INF/encryption.xml', 512 * 1024);
      for (final element
          in encryption.descendants.whereType<XmlElement>().where(
            (e) => e.name.local == 'EncryptionMethod',
          )) {
        if (!const {
          'http://www.idpf.org/2008/embedding',
          'http://ns.adobe.com/pdf/enc#RC',
        }.contains(element.getAttribute('Algorithm'))) {
          throw const FormatException(
            'Encrypted or DRM-protected EPUBs are not supported.',
          );
        }
      }
    }
    final container = xml('META-INF/container.xml', 128 * 1024);
    final roots = container.descendants.whereType<XmlElement>().where(
      (e) => e.name.local == 'rootfile',
    );
    final packagePath = roots.firstOrNull?.getAttribute('full-path');
    if (packagePath == null ||
        packagePath.startsWith('/') ||
        packagePath.split('/').contains('..')) {
      throw const FormatException('The EPUB package is missing.');
    }
    final package = xml(packagePath, 2 * 1024 * 1024);
    if (package.rootElement.name.local != 'package' ||
        !package.descendants.whereType<XmlElement>().any(
          (e) => e.name.local == 'itemref',
        )) {
      throw const FormatException('The EPUB has no reading order.');
    }
    final manifest = <String, String>{
      for (final item in package.descendants.whereType<XmlElement>().where(
        (e) => e.name.local == 'item',
      ))
        if (item.getAttribute('id') != null &&
            item.getAttribute('href') != null)
          item.getAttribute('id')!: item.getAttribute('href')!,
    };
    for (final item in package.descendants.whereType<XmlElement>().where(
      (e) => e.name.local == 'itemref',
    )) {
      final href = manifest[item.getAttribute('idref')];
      final resolved = href == null
          ? null
          : Uri(path: packagePath).resolve(href);
      if (resolved == null ||
          resolved.hasScheme ||
          resolved.hasAuthority ||
          !headers.containsKey(Uri.decodeComponent(resolved.path))) {
        throw const FormatException(
          'The EPUB is missing a reading-order chapter.',
        );
      }
    }
    final metadata = package.descendants
        .whereType<XmlElement>()
        .where((e) => e.name.local == 'metadata')
        .firstOrNull;
    String clean(String text, int limit) {
      var result = text
          .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ')
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim();
      if (result.length > limit) {
        result = result.substring(0, limit);
        if (result.codeUnitAt(result.length - 1) >= 0xd800 &&
            result.codeUnitAt(result.length - 1) <= 0xdbff) {
          result = result.substring(0, result.length - 1);
        }
      }
      return result;
    }

    String value(String name, String fallback, int limit) {
      final text =
          metadata?.childElements
              .where((e) => e.name.local == name)
              .map((e) => e.innerText.trim())
              .where((e) => e.isNotEmpty)
              .join(name == 'creator' ? '; ' : ' ') ??
          '';
      final result = clean(text, limit);
      return result.isEmpty ? fallback : result;
    }

    final language = value('language', 'und', 32);
    return {
      'sha256': digest.toString(),
      'fileSize': size,
      'title': value('title', 'Untitled', 300),
      'author': value('creator', 'Unknown', 300),
      'description': value('description', '', 4000),
      'language':
          RegExp(r'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$').hasMatch(language)
          ? language
          : 'und',
      'subjects':
          metadata?.childElements
              .where((e) => e.name.local == 'subject')
              .map((e) => clean(e.innerText, 100))
              .where((s) => s.isNotEmpty)
              .toSet()
              .take(32)
              .toList() ??
          <String>[],
    };
  } finally {
    await input.close();
  }
}

class _BoundedOutput extends OutputMemoryStream {
  _BoundedOutput(this.limit) : super(size: 1024);
  final int limit;
  void _check(int amount) {
    if (length + amount > limit) {
      throw const FormatException(
        'The EPUB metadata expands beyond its size limit.',
      );
    }
  }

  @override
  void writeByte(int value) {
    _check(1);
    super.writeByte(value);
  }

  @override
  void writeBytes(List<int> bytes, {int? length}) {
    _check(length ?? bytes.length);
    super.writeBytes(bytes, length: length);
  }

  @override
  void writeStream(InputStream stream) {
    _check(stream.length);
    super.writeStream(stream);
  }

  @override
  void writeBackReference(int distance, int count) {
    _check(count);
    super.writeBackReference(distance, count);
  }
}
