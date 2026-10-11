part of pdf_extractor;

String _utf16(Uint8List b, [bool little = false]) {
  final out = <int>[];
  for (var i = 0; i + 1 < b.length; i += 2) {
    var n = little ? b[i + 1] * 256 + b[i] : b[i] * 256 + b[i + 1];
    if (n >= 0xd800 && n <= 0xdbff) {
      if (i + 3 < b.length) {
        final next = little
            ? b[i + 3] * 256 + b[i + 2]
            : b[i + 2] * 256 + b[i + 3];
        if (next >= 0xdc00 && next <= 0xdfff) {
          out.add(0x10000 + (n - 0xd800) * 1024 + next - 0xdc00);
          i += 2;
          continue;
        }
      }
      n = 0xfffd;
    } else if (n >= 0xdc00 && n <= 0xdfff) {
      n = 0xfffd;
    }
    out.add(n);
  }
  return String.fromCharCodes(out);
}

String _decodeText(Uint8List b) {
  if (b.length >= 2 && b[0] == 254 && b[1] == 255) return _utf16(_slice(b, 2));
  if (b.length >= 2 && b[0] == 255 && b[1] == 254)
    return _utf16(_slice(b, 2), true);
  if (b.length >= 3 && b[0] == 239 && b[1] == 187 && b[2] == 191)
    return utf8.decode(_slice(b, 3), allowMalformed: true);
  final extra = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž�€'.runes.toList();
  return String.fromCharCodes(
    b.map((c) => c >= 128 && c - 128 < extra.length ? extra[c - 128] : c),
  );
}

String _textString(Object? v) => v is _Literal ? _decodeText(v.bytes) : '';
List<String> _baseEncoding(String kind) => List<String>.from(
  kind == 'WinAnsiEncoding'
      ? _winEncoding
      : kind == 'MacRomanEncoding'
      ? _macEncoding
      : _standardEncoding,
);
const _greek = {
  'Alpha': 'Α',
  'Beta': 'Β',
  'Gamma': 'Γ',
  'Delta': 'Δ',
  'Theta': 'Θ',
  'Lambda': 'Λ',
  'Sigma': 'Σ',
  'Phi': 'Φ',
  'Psi': 'Ψ',
  'Omega': 'Ω',
  'alpha': 'α',
  'beta': 'β',
  'gamma': 'γ',
  'delta': 'δ',
  'epsilon': 'ε',
  'theta': 'θ',
  'lambda': 'λ',
  'pi': 'π',
  'rho': 'ρ',
  'sigma': 'σ',
  'tau': 'τ',
  'phi': 'φ',
  'chi': 'χ',
  'psi': 'ψ',
  'omega': 'ω',
};
String _glyphName(String value) {
  final s = value.split('.').first;
  if (_greek.containsKey(s)) return _greek[s]!;
  if (_glyphs.containsKey(s)) return _glyphs[s]!;
  if (s.contains('_')) return s.split('_').map(_glyphName).join();
  if (s.runes.length == 1) return s;
  if (RegExp(r'^uni(?:[\da-f]{4})+$', caseSensitive: false).hasMatch(s)) {
    final bytes = <int>[];
    for (var j = 3; j < s.length; j += 4) {
      final n = int.parse(s.substring(j, j + 4), radix: 16);
      bytes.addAll([n >> 8, n & 255]);
    }
    return _utf16(Uint8List.fromList(bytes));
  }
  if (RegExp(r'^u[\da-f]{4,6}$', caseSensitive: false).hasMatch(s)) {
    final n = int.parse(s.substring(1), radix: 16);
    if (n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))
      return String.fromCharCode(n);
  }
  for (final suffix in ['Bigg', 'bigg', 'Big', 'big', 'display', 'text'])
    if (s.endsWith(suffix)) {
      final base = s.substring(0, s.length - suffix.length);
      if (_glyphs.containsKey(base)) return _glyphs[base]!;
    }
  return _texGlyphs[s] ?? '�';
}

int _codeValue(Uint8List b) {
  var n = 0;
  for (final c in b) n = n * 256 + c;
  return n;
}

String _codeBytes(int n, int length) {
  final b = Uint8List(length);
  for (var i = length - 1; i >= 0; i--) {
    b[i] = n & 255;
    n = n ~/ 256;
  }
  return _binary(b);
}

(Map<String, String>, List<int>) _parseCMap(Uint8List b) {
  final unicode = <String, String>{}, lengths = <int>{}, l = _Lexer(b);
  var expanded = 0;
  Object? previous;
  while (l.pos < b.length) {
    l.skip();
    if (l.pos == b.length) break;
    final v = l.value();
    if (v is! _Keyword) {
      previous = v;
      continue;
    }
    final count = _integer(previous);
    if (count < 0 || count > 65536) _limit();
    if (v.value == 'beginbfchar') {
      expanded += count;
      if (expanded > 100000) _limit();
      for (var i = 0; i < count; i++) {
        final src = l.value(), dst = l.value();
        if (src is! _Literal ||
            dst is! _Literal ||
            src.bytes.isEmpty ||
            src.bytes.length > 4)
          _invalid('Invalid CMap character');
        if (dst.bytes.length > 256) _limit();
        unicode[_binary(src.bytes)] = _utf16(dst.bytes);
        lengths.add(src.bytes.length);
      }
    } else if (v.value == 'beginbfrange') {
      for (var i = 0; i < count; i++) {
        final a = l.value(), z = l.value(), dest = l.value();
        if (a is! _Literal ||
            z is! _Literal ||
            a.bytes.isEmpty ||
            a.bytes.length > 4 ||
            a.bytes.length != z.bytes.length)
          _invalid('Invalid CMap range');
        final start = _codeValue(a.bytes), end = _codeValue(z.bytes);
        if (end < start || end - start > 65536) _limit();
        expanded += end - start + 1;
        if (expanded > 100000) _limit();
        lengths.add(a.bytes.length);
        for (var offset = 0; offset <= end - start; offset++) {
          final key = _codeBytes(start + offset, a.bytes.length);
          if (dest is _Literal) {
            if (dest.bytes.length > 256) _limit();
            final dst = Uint8List.fromList(dest.bytes);
            var carry = offset;
            for (var j = dst.length - 1; j >= 0 && carry > 0; j--) {
              carry += dst[j];
              dst[j] = carry & 255;
              carry = carry ~/ 256;
            }
            unicode[key] = _utf16(dst);
          } else if (dest is List && offset < dest.length) {
            final d = dest[offset],
                dst = d is _Literal ? d.bytes : Uint8List(0);
            if (dst.length > 256) _limit();
            unicode[key] = _utf16(dst);
          }
        }
      }
    }
    previous = null;
  }
  return (unicode, lengths.toList()..sort((a, b) => b - a));
}

class _Font {
  String base = '';
  bool bold = false,
      italic = false,
      mono = false,
      cid = false,
      vertical = false,
      math = false;
  List<String> encoding = _baseEncoding(''), names = List.filled(256, '');
  Map<String, String> unicode = {};
  List<int> lengths = [];
  Map<int, double> widths = {};
  double defaultWidth = 500;
  _Dict source = {}, descriptor = {};
  Object? gidMap;
  (String, int, int) glyph(Uint8List s) {
    for (final n in lengths)
      if (n <= s.length) {
        final u = unicode[_binary(_slice(s, 0, n))];
        if (u != null) return (u, _codeValue(_slice(s, 0, n)), n);
      }
    final n = mathMinInt(cid ? 2 : 1, s.length),
        code = _codeValue(_slice(s, 0, n));
    return (
      cid
          ? '�'
          : encoding[code & 255].isEmpty
          ? '�'
          : encoding[code & 255],
      code,
      n,
    );
  }

  double width(int code, String text) {
    final value = widths[code];
    if (value != null) return value;
    if (mono || cid) return defaultWidth;
    if (text.length == 1) {
      if (text == ' ') return 278;
      if ("ilI.,'!:;|".contains(text)) return 250;
      if ('mwMW@'.contains(text)) return 800;
      if (text.compareTo('A') >= 0 && text.compareTo('Z') <= 0) return 667;
    }
    return defaultWidth;
  }
}

int mathMinInt(int a, int b) => a < b ? a : b;

class _Fonts {
  final _PDF p;
  final cache = <_Ref, _Font>{};
  bool Function(_Font, int)? recoverEncoding;
  _Fonts(this.p);
  _Font get(Object? v, int page) {
    final ref = v is _Ref ? v : null, cached = ref == null ? null : cache[ref];
    if (cached != null) return cached;
    final d = p.dict(v), f = _Font();
    f.base = _named(d['BaseFont']);
    f.source = d;
    final lower = f.base.toLowerCase(),
        bare = lower.substring(lower.lastIndexOf('+') + 1);
    f.bold =
        RegExp(r'bold|black|demi|-bd$').hasMatch(lower) ||
        RegExp(r'^(cmbx|sfbx)').hasMatch(bare);
    f.italic =
        RegExp(r'ital|oblique').hasMatch(lower) ||
        RegExp(r'^(cmti|sfti)').hasMatch(bare);
    f.mono =
        RegExp(r'courier|mono|consolas').hasMatch(lower) ||
        RegExp(r'^(cmtt|sftt|sfvt|sfit)').hasMatch(bare);
    f.math =
        lower.contains('math') ||
        RegExp(r'^(cmmi|cmsy|cmex|msam|msbm|eurm|eufm)').hasMatch(bare);
    f.cid = _named(d['Subtype']) == 'Type0';
    final enc = p.resolve(d['Encoding']);
    var kind = _named(enc);
    f.vertical = kind.endsWith('-V');
    if (f.vertical)
      p.warn(
        'vertical-text',
        page,
        'Vertical writing is preserved but reading order needs review.',
      );
    if (f.cid && kind != 'Identity-H' && kind != 'Identity-V')
      p.warn(
        'font-cmap',
        page,
        'Non-Identity CID encodings need review: $kind',
      );
    final ed = _asDict(enc);
    if (ed.isNotEmpty) kind = _named(ed['BaseEncoding']);
    f.encoding = _baseEncoding(kind);
    if (f.mono) f.defaultWidth = 600;
    final differences = p.array(ed['Differences']);
    for (var i = 0; i < differences.length;) {
      var code = _integer(differences[i++]);
      while (i < differences.length && differences[i] is _Name) {
        final n = _named(differences[i++]);
        if (code >= 0 && code < 256) {
          f.encoding[code] = _glyphName(n);
          f.names[code] = n;
        }
        code++;
      }
    }
    var fd = d;
    if (f.cid) {
      final descendants = p.array(d['DescendantFonts']);
      if (descendants.isNotEmpty) fd = p.dict(descendants[0]);
      f.defaultWidth = fd.containsKey('DW')
          ? _number(p.resolve(fd['DW']))
          : 1000;
      final w = p.array(fd['W']);
      var expanded = 0;
      for (var i = 0; i < w.length;) {
        p.check();
        final start = _integer(w[i++]);
        if (i == w.length) break;
        final value = p.resolve(w[i]);
        if (value is List<Object?>) {
          i++;
          expanded += value.length;
          if (expanded > 100000) _limit();
          for (var j = 0; j < value.length; j++)
            f.widths[start + j] = _number(value[j]);
        } else {
          final end = _integer(w[i++]);
          if (i == w.length) break;
          final width = _number(w[i++]);
          if (start < 0 || end < start || end - start > 65536) _limit();
          expanded += end - start + 1;
          if (expanded > 100000) _limit();
          for (var c = start; c <= end; c++) f.widths[c] = width;
        }
      }
    } else {
      final first = _integer(d['FirstChar']),
          matrix = p.array(d['FontMatrix']),
          scale = _named(d['Subtype']) == 'Type3' && matrix.length == 6
              ? _number(matrix[0]) * 1000
              : 1.0,
          widths = p.array(d['Widths']);
      for (var i = 0; i < widths.length; i++)
        f.widths[first + i] = _number(widths[i]) * scale;
    }
    f.descriptor = p.dict(fd['FontDescriptor']);
    f.gidMap = fd['CIDToGIDMap'];
    final flags = _integer(f.descriptor['Flags']);
    f.mono = f.mono || (flags & 1) != 0;
    f.italic = f.italic || (flags & 64) != 0;
    if (_number(f.descriptor['MissingWidth']) > 0)
      f.defaultWidth = _number(f.descriptor['MissingWidth']);
    final cmap = p.resolve(d['ToUnicode']);
    if (cmap is _Stream) {
      try {
        final (u, l) = _parseCMap(p.decode(cmap));
        f.unicode = u;
        f.lengths = l;
      } catch (e) {
        if (e is PdfException &&
            (e.code == 'RESOURCE_LIMIT' || e.code == 'ABORTED'))
          rethrow;
        p.warn(
          'font-unicode',
          page,
          e is PdfException ? e.message : e.toString(),
        );
      }
    }
    if (!f.cid &&
        d['Encoding'] == null &&
        (f.descriptor['FontFile'] != null ||
            f.descriptor['FontFile3'] != null)) {
      if (recoverEncoding?.call(f, page) == true) {
        for (var code = 0; code < 256; code++)
          if (f.names[code].isNotEmpty)
            f.encoding[code] = _glyphName(f.names[code]);
      } else {
        p.warn(
          'font-encoding',
          page,
          'Embedded simple-font encoding could not be resolved; StandardEncoding fallback is approximate.',
        );
      }
    }
    if (f.cid && f.unicode.isEmpty)
      p.warn(
        'missing-unicode',
        page,
        'CID font ${f.base} has no usable ToUnicode map; unmapped glyphs are marked �.',
      );
    if (RegExp(r'symbol|dingbat').hasMatch(lower) && f.unicode.isEmpty)
      p.warn(
        'symbol-font',
        page,
        'Symbol font ${f.base} has no ToUnicode map; glyphs need review.',
      );
    if (ref != null) cache[ref] = f;
    return f;
  }
}
