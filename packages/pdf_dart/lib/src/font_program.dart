part of pdf_extractor;

Uint8List _type1Decrypt(Uint8List b, int seed, int skip) {
  final out = Uint8List(b.length);
  for (var j = 0; j < b.length; j++) {
    final c = b[j];
    out[j] = c ^ (seed >> 8);
    seed = ((c + seed) * 52845 + 22719) & 65535;
  }
  return skip < 0 || skip > out.length ? Uint8List(0) : _slice(out, skip);
}

(_OutlineFont, List<String>) _parseType1(
  Uint8List b,
  int length1,
  int length2,
) {
  if (length1 <= 0 ||
      length1 > b.length ||
      length2 < 0 ||
      length2 > b.length - length1)
    _invalid();
  final clear = _slice(b, 0, length1),
      text = _binary(clear),
      names = List.filled(256, '');
  for (final m in RegExp(
    r'\bdup\s+(\d+)\s+/([^\s]+)\s+put\b',
  ).allMatches(text)) {
    final n = int.parse(m[1]!);
    if (n >= 0 && n < 256) names[n] = m[2]!;
  }
  var encrypted = _slice(b, length1, length1 + length2);
  final compact = _binary(encrypted).replaceAll(RegExp(r'\s'), '');
  if (compact.length >= 4 &&
      compact.length.isEven &&
      RegExp(r'^[\da-f]+$', caseSensitive: false).hasMatch(compact))
    encrypted = _hexDecode(compact);
  final private = _type1Decrypt(encrypted, 55665, 4);
  if (private.isEmpty) _invalid();
  var header = _binary(private), lenIV = 4;
  final subrsAt = header.indexOf('/Subrs');
  if (subrsAt >= 0) header = header.substring(0, subrsAt);
  final match = RegExp(r'/lenIV\s+(-?\d+)').firstMatch(header);
  if (match != null) {
    lenIV = int.parse(match[1]!);
    if (lenIV < -1 || lenIV > 32) _invalid();
  }
  final f = _OutlineFont()
    ..type1 = true
    ..names = {};
  final matrixAt = text.indexOf('/FontMatrix');
  if (matrixAt >= 0) {
    final a = _asArray(_Lexer(clear, matrixAt + 11).value());
    if (a.length == 6) {
      f.matrix = a.map(_number).toList();
      _validMatrix(f.matrix);
    }
  }
  var at = 0;
  String token() {
    while (at < private.length && private[at] <= 32) at++;
    final start = at;
    while (at < private.length && private[at] > 32) at++;
    return _binary(_slice(private, start, at));
  }

  int? intToken() => int.tryParse(token());
  Uint8List decode(int n) {
    if (n < 0 ||
        n > private.length - at - 1 ||
        at >= private.length ||
        private[at] > 32)
      _invalid();
    at++;
    final v = _slice(private, at, at + n);
    at += n;
    if (lenIV == -1) return v;
    if (n < lenIV) _invalid();
    return _type1Decrypt(v, 4330, lenIV);
  }

  var subrs = <Uint8List>[], inChars = false;
  while (at < private.length) {
    final t = token();
    if (t == '/Subrs') {
      final n = intToken();
      if (n == null || n < 0 || n > 65536) _invalid();
      subrs = List.generate(n, (_) => Uint8List(0));
    } else if (t == '/CharStrings') {
      inChars = true;
    } else if (!inChars && t == 'dup' && subrs.isNotEmpty) {
      final idx = intToken();
      if (idx == null) continue;
      final n = intToken();
      if (n == null) continue;
      final op = token();
      if (op != 'RD' && op != '-|') continue;
      if (idx < 0 || idx >= subrs.length) _invalid();
      subrs[idx] = decode(n);
    } else if (inChars && t.startsWith('/')) {
      final name = t.substring(1), n = intToken();
      if (n == null) continue;
      final op = token();
      if (op != 'RD' && op != '-|') continue;
      if (f.chars.length >= 65536) _limit();
      final v = decode(n);
      f.names![name] = f.chars.length;
      f.chars.add(v);
    }
  }
  if (f.chars.isEmpty) _invalid();
  f.fd = List.filled(f.chars.length, 0);
  f.local = [subrs];
  return (f, names);
}

class _FontPrograms {
  final _PDF p;
  final cache = <_Font, _OutlineFont?>{};
  _FontPrograms(this.p, _Fonts fonts) {
    fonts.recoverEncoding = (f, page) => get(f, page) != null;
  }
  _OutlineFont? get(_Font f, int page) {
    if (cache.containsKey(f)) return cache[f];
    cache[f] = null;
    late _OutlineFont prog;
    try {
      if (_named(f.source['Subtype']) == 'Type3') {
        prog = _OutlineFont()
          ..type3 = true
          ..names = {};
        final a = p.array(f.source['FontMatrix']);
        if (a.length == 6) prog.matrix = a.map(_number).toList();
        final chars = p.dict(f.source['CharProcs']),
            keys = chars.keys.toList()..sort();
        for (final name in keys) {
          final s = p.resolve(chars[name]);
          if (s is! _Stream) continue;
          final b = p.decode(s);
          prog.names![name] = prog.chars.length;
          prog.chars.add(b);
        }
        if (prog.chars.isEmpty) _invalid();
        prog.draw = (c, gid) => _type3Outline(c, prog.chars[gid]);
      } else {
        final cff = p.resolve(f.descriptor['FontFile3']),
            ttf = p.resolve(f.descriptor['FontFile2']),
            type1 = p.resolve(f.descriptor['FontFile']);
        if (cff is _Stream) {
          prog = _parseCFF(p.decode(cff));
          if (prog.names != null) {
            final byGID = <int, String>{},
                byUnicode = <String, String>{},
                keys = prog.names!.keys.toList()..sort();
            for (final name in keys) {
              byGID[prog.names![name]!] = name;
              final u = _glyphName(name);
              if (u.isNotEmpty && u != '�') byUnicode[u] = name;
            }
            for (var code = 0; code < 256; code++)
              if (f.names[code].isEmpty) {
                final gid = prog.codes[code];
                f.names[code] = f.source['Encoding'] == null
                    ? gid != null
                          ? byGID[gid] ?? ''
                          : ''
                    : byUnicode[f.encoding[code]] ?? '';
              }
          }
        } else if (ttf is _Stream) {
          final tt = _TrueTypeFont(p.decode(ttf));
          prog = _OutlineFont()
            ..glyphCount = tt.glyphs
            ..matrix = [1 / tt.units, 0, 0, 1 / tt.units, 0, 0]
            ..draw = ((c, gid) => tt.draw(c, gid, _identity));
          if (f.cid) {
            final s = p.resolve(f.gidMap);
            if (s is _Stream) {
              final v = p.decode(s);
              if (v.length > 131072) _limit();
              for (var j = 0; j + 1 < v.length; j += 2) {
                final gid = _u16(v, j);
                if (gid < tt.glyphs) prog.codes[j ~/ 2] = gid;
              }
            } else {
              for (var j = 0; j < tt.glyphs; j++) prog.codes[j] = j;
            }
          } else {
            for (var code = 0; code < 256; code++) {
              final u = f.glyph(Uint8List.fromList([code])).$1;
              var gid = tt.lookup(u.isEmpty ? 0xfffd : u.runes.first);
              if (gid == 0) gid = tt.lookup(code + 0xf000);
              if (gid > 0) prog.codes[code] = gid;
            }
          }
        } else if (type1 is _Stream) {
          final (program, names) = _parseType1(
            p.decode(type1),
            _integer(p.resolve(type1.dict['Length1'])),
            _integer(p.resolve(type1.dict['Length2'])),
          );
          prog = program;
          final byUnicode = <String, String>{},
              keys = prog.names!.keys.toList()..sort();
          for (final key in keys) {
            final u = _glyphName(key);
            if (u.isNotEmpty && u != '�') byUnicode[u] = key;
          }
          for (var code = 0; code < 256; code++) {
            if (f.names[code].isEmpty) f.names[code] = names[code];
            if (f.names[code].isEmpty)
              f.names[code] =
                  byUnicode[f.glyph(Uint8List.fromList([code])).$1] ?? '';
          }
        } else {
          _invalid('no supported embedded CFF/Type 1 program');
        }
      }
      cache[f] = prog;
      return prog;
    } catch (e) {
      if (e is PdfException &&
          (e.code == 'RESOURCE_LIMIT' || e.code == 'ABORTED'))
        rethrow;
      p.warn(
        'font-outline',
        page,
        'Positioned graphics use Unicode fallback for ${f.base}: ${e is PdfException ? e.message : e}',
      );
      return null;
    }
  }
}
