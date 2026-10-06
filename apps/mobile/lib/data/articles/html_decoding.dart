import 'dart:convert';

import 'package:charset/charset.dart' as charset;
import 'package:cp949_codec/cp949_codec.dart';
import 'package:enough_convert/enough_convert.dart';

/// Decodes an HTML response the way a browser does: a byte order mark wins,
/// then the Content-Type charset, then a `<meta charset>` or `http-equiv`
/// declaration in the first 2 KB, else UTF-8. Labels follow the WHATWG
/// Encoding Standard; unsupported ones fall back to UTF-8. Never throws on
/// malformed bytes.
String decodeHtml(List<int> bytes, {String? contentType}) {
  if (_startsWith(bytes, const [0xEF, 0xBB, 0xBF])) return _utf8(bytes.sublist(3));
  if (_startsWith(bytes, const [0xFE, 0xFF])) return _utf16(bytes.sublist(2), bigEndian: true);
  if (_startsWith(bytes, const [0xFF, 0xFE])) return _utf16(bytes.sublist(2), bigEndian: false);
  final label = charsetOf(contentType) ?? sniffMetaCharset(bytes);
  final decode = label == null ? null : decoderFor(label);
  if (decode == null) return _utf8(bytes);
  try {
    return decode(bytes);
  } catch (_) {
    // Some legacy decoders throw on a truncated final sequence.
    return _utf8(bytes);
  }
}

final _charsetParam = RegExp(r'''charset\s*=\s*["']?\s*([^"';\s>/]+)''', caseSensitive: false);
final _meta = RegExp(r'<meta\b[^>]*>', caseSensitive: false);

/// The `charset` parameter of a Content-Type value.
String? charsetOf(String? contentType) =>
    contentType == null ? null : _charsetParam.firstMatch(contentType)?.group(1);

/// The charset declared by a `<meta>` element in the first 2 KB. A UTF-16
/// declaration means UTF-8, as in browsers: the bytes were readable as ASCII.
String? sniffMetaCharset(List<int> bytes) {
  final head = latin1.decode(bytes.length > 2048 ? bytes.sublist(0, 2048) : bytes);
  for (final tag in _meta.allMatches(head)) {
    final label = _charsetParam.firstMatch(tag.group(0)!)?.group(1);
    if (label == null) continue;
    return label.toLowerCase().startsWith('utf-16') ? 'utf-8' : label;
  }
  return null;
}

/// A tolerant decoder for a WHATWG encoding label, or null when the label is
/// unknown or unsupported.
String Function(List<int>)? decoderFor(String label) {
  final l = label.trim().toLowerCase();
  if (_utf8Labels.contains(l)) return _utf8;
  if (_windows1252Labels.contains(l)) return const Windows1252Codec(allowInvalid: true).decode;
  if (_koi8rLabels.contains(l)) return const Koi8rCodec(allowInvalid: true).decode;
  if (l == 'koi8-u' || l == 'koi8-ru') return const Koi8uCodec(allowInvalid: true).decode;
  if (_gbkLabels.contains(l)) return const GbkCodec(allowInvalid: true).decode;
  if (_big5Labels.contains(l)) return const Big5Codec(allowInvalid: true).decode;
  if (_shiftJisLabels.contains(l)) return const charset.ShiftJISCodec(allowMalformed: true).decode;
  if (_eucJpLabels.contains(l)) return const charset.EucJPDecoder().convert;
  if (_eucKrLabels.contains(l)) return const CP949Codec(allowInvalid: true).decode;
  if (l == 'utf-16be' || l == 'unicodefffe') return (b) => _utf16(b, bigEndian: true);
  if (_utf16leLabels.contains(l)) return (b) => _utf16(b, bigEndian: false);
  final windows = RegExp(r'^(?:windows-|cp|x-cp)(874|125[0-8])$').firstMatch(l);
  if (windows != null) return _windows(int.parse(windows.group(1)!));
  final iso = RegExp(r'^(?:iso[-_]?8859[-_]?|iso_8859-)(\d{1,2})(?::\d{4})?$').firstMatch(l);
  final part = iso != null ? int.parse(iso.group(1)!) : _isoAliases[l];
  return part == null ? null : _iso8859(part);
}

String Function(List<int>)? _windows(int page) => switch (page) {
  874 => (b) => charset.windows874.decode(b, allowInvalid: true),
  1250 => const Windows1250Codec(allowInvalid: true).decode,
  1251 => const Windows1251Codec(allowInvalid: true).decode,
  1252 => const Windows1252Codec(allowInvalid: true).decode,
  1253 => const Windows1253Codec(allowInvalid: true).decode,
  1254 => const Windows1254Codec(allowInvalid: true).decode,
  1255 => const Windows1255Codec(allowInvalid: true).decode,
  1256 => const Windows1256Codec(allowInvalid: true).decode,
  1257 => (b) => charset.windows1257.decode(b, allowInvalid: true),
  1258 => (b) => charset.windows1258.decode(b, allowInvalid: true),
  _ => null,
};

/// ISO-8859 parts. As in browsers, part 1 reads as windows-1252, part 9 as
/// windows-1254 and part 11 as windows-874.
String Function(List<int>)? _iso8859(int part) => switch (part) {
  1 => _windows(1252),
  2 => const Latin2Codec(allowInvalid: true).decode,
  3 => const Latin3Codec(allowInvalid: true).decode,
  4 => const Latin4Codec(allowInvalid: true).decode,
  5 => const Latin5Codec(allowInvalid: true).decode,
  6 => const Latin6Codec(allowInvalid: true).decode,
  7 => const Latin7Codec(allowInvalid: true).decode,
  8 => const Latin8Codec(allowInvalid: true).decode,
  9 => _windows(1254),
  10 => const Latin10Codec(allowInvalid: true).decode,
  11 => _windows(874),
  13 => const Latin13Codec(allowInvalid: true).decode,
  14 => const Latin14Codec(allowInvalid: true).decode,
  15 => const Latin15Codec(allowInvalid: true).decode,
  16 => const Latin16Codec(allowInvalid: true).decode,
  _ => null,
};

String _utf8(List<int> bytes) => utf8.decode(bytes, allowMalformed: true);

String _utf16(List<int> bytes, {required bool bigEndian}) {
  final units = List<int>.generate(
    bytes.length ~/ 2,
    (i) => bigEndian ? bytes[2 * i] << 8 | bytes[2 * i + 1] : bytes[2 * i + 1] << 8 | bytes[2 * i],
  );
  return String.fromCharCodes(units);
}

bool _startsWith(List<int> bytes, List<int> prefix) {
  if (bytes.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) {
    if (bytes[i] != prefix[i]) return false;
  }
  return true;
}

const _utf8Labels = {'utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8'};
const _windows1252Labels = {
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', //
  'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
};
const _koi8rLabels = {'cskoi8r', 'koi', 'koi8', 'koi8-r', 'koi8_r'};
const _gbkLabels = {
  'chinese', 'csgb2312', 'csiso58gb231280', 'gb2312', 'gb_2312', 'gb_2312-80', 'gbk', 'iso-ir-58', 'x-gbk', //
  'gb18030', 'cp936', 'ms936', 'windows-936',
};
const _big5Labels = {'big5', 'big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5'};
const _shiftJisLabels = {'csshiftjis', 'ms932', 'ms_kanji', 'shift-jis', 'shift_jis', 'sjis', 'windows-31j', 'x-sjis'};
const _eucJpLabels = {'cseucpkdfmtjapanese', 'euc-jp', 'x-euc-jp'};
const _eucKrLabels = {
  'cseuckr', 'csksc56011987', 'euc-kr', 'iso-ir-149', 'korean', 'ks_c_5601-1987', 'ks_c_5601-1989', 'ksc5601', //
  'ksc_5601', 'windows-949',
};
const _utf16leLabels = {'csunicode', 'iso-10646-ucs-2', 'ucs-2', 'unicode', 'unicodefeff', 'utf-16', 'utf-16le'};
const _isoAliases = {
  'l2': 2, 'latin2': 2, 'csisolatin2': 2, 'iso-ir-101': 2, //
  'l3': 3, 'latin3': 3, 'csisolatin3': 3, 'iso-ir-109': 3,
  'l4': 4, 'latin4': 4, 'csisolatin4': 4, 'iso-ir-110': 4,
  'cyrillic': 5, 'csisolatincyrillic': 5, 'iso-ir-144': 5,
  'arabic': 6, 'asmo-708': 6, 'csiso88596e': 6, 'csiso88596i': 6, 'csisolatinarabic': 6, 'ecma-114': 6, //
  'iso-8859-6-e': 6, 'iso-8859-6-i': 6, 'iso-ir-127': 6,
  'greek': 7, 'greek8': 7, 'csisolatingreek': 7, 'ecma-118': 7, 'elot_928': 7, 'iso-ir-126': 7, 'sun_eu_greek': 7,
  'hebrew': 8, 'csisolatinhebrew': 8, 'iso-ir-138': 8, 'visual': 8, 'iso-8859-8-i': 8, 'csiso88598e': 8, //
  'csiso88598i': 8, 'iso-8859-8-e': 8, 'logical': 8,
  'l5': 9, 'latin5': 9, 'csisolatin5': 9, 'iso-ir-148': 9,
  'l6': 10, 'latin6': 10, 'csisolatin6': 10, 'iso-ir-157': 10,
  'tis-620': 11, 'dos-874': 11,
  'csiso885913': 13,
  'csiso885914': 14,
  'l9': 15, 'csisolatin9': 15,
  'csiso885915': 15,
};
