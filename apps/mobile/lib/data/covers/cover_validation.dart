import 'dart:convert';
import 'dart:typed_data';
import 'package:xml/xml.dart';

bool isSvgCover(Uint8List bytes) => utf8
    .decode(bytes.take(512).toList(), allowMalformed: true)
    .trimLeft()
    .startsWith('<');

/// Neither local EPUB artwork nor a custom catalog may load secondary URLs.
bool validCoverBytes(Uint8List bytes) {
  if (bytes.isEmpty || bytes.length > 4 * 1024 * 1024) return false;
  if (isSvgCover(bytes)) {
    if (bytes.length > 2 * 1024 * 1024) return false;
    try {
      final text = utf8.decode(bytes);
      bool unsafeCss(String value) {
        if (RegExp(
          r'@import|@font-face',
          caseSensitive: false,
        ).hasMatch(value)) {
          return true;
        }
        for (final match in RegExp(
          r'url\s*\(([^)]*)\)',
          caseSensitive: false,
        ).allMatches(value)) {
          final ref = match
              .group(1)!
              .trim()
              .replaceAll('"', '')
              .replaceAll("'", '');
          if (!ref.startsWith('#')) return true;
        }
        return false;
      }

      if (RegExp(r'<!DOCTYPE|<!ENTITY', caseSensitive: false).hasMatch(text) ||
          unsafeCss(text)) {
        return false;
      }
      final xml = XmlDocument.parse(text);
      if (xml.rootElement.name.local != 'svg') return false;
      // XML numeric entities are decoded before CSS reaches the renderer.
      // Validate decoded text and attributes as well as the serialized input.
      for (final node in xml.descendants) {
        if (node is XmlText && unsafeCss(node.value)) return false;
        if (node is XmlCDATA && unsafeCss(node.value)) return false;
      }
      for (final e in xml.descendants.whereType<XmlElement>()) {
        if (const {
          'script',
          'foreignObject',
          'a',
          'animate',
          'set',
        }.contains(e.name.local)) {
          return false;
        }
        for (final a in e.attributes) {
          if (unsafeCss(a.value)) return false;
          if (a.name.local.toLowerCase().startsWith('on')) return false;
          if ((a.name.local == 'href' || a.name.local == 'src') &&
              !a.value.startsWith('#') &&
              !RegExp(
                r'^data:image/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$',
              ).hasMatch(a.value)) {
            return false;
          }
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }
  bool starts(List<int> sig) =>
      bytes.length >= sig.length &&
      List.generate(sig.length, (i) => bytes[i] == sig[i]).every((v) => v);
  return starts([0xff, 0xd8, 0xff]) ||
      starts([137, 80, 78, 71, 13, 10, 26, 10]) ||
      starts(ascii.encode('GIF87a')) ||
      starts(ascii.encode('GIF89a')) ||
      (bytes.length >= 12 &&
          starts(ascii.encode('RIFF')) &&
          ascii.decode(bytes.sublist(8, 12), allowInvalid: true) == 'WEBP');
}
