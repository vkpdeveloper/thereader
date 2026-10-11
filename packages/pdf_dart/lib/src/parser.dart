part of pdf_extractor;

class _XEntry {
  final int type, offset, gen;
  const _XEntry(this.type, this.offset, this.gen);
}

class _PDF {
  final Uint8List data;
  final Options options;
  final Limits limits;
  final Document out = Document();
  final Stopwatch clock = Stopwatch()..start();
  final xref = <int, _XEntry>{},
      objects = <_Ref, Object?>{},
      loading = <_Ref>{},
      decoded = <_Stream, Uint8List>{},
      objectStreams = <int>{},
      warned = <String>{},
      assetIDs = <_Stream, String>{};
  _Dict trailer = {};
  int decodedSize = 0,
      operations = 0,
      spanCount = 0,
      assetBytes = 0,
      outlineBytes = 0;
  _PDF(this.data, [this.options = const Options()])
    : limits = options.limits.normalized() {
    check();
    if (data.length > limits.inputBytes) _limit();
    if (!_binary(
      _slice(data, 0, math.min(1024, data.length)),
    ).contains('%PDF-'))
      _invalid('Missing PDF header');
    const marker = [115, 116, 97, 114, 116, 120, 114, 101, 102];
    var start = -1;
    outer:
    for (var i = data.length - marker.length; i >= 0; i--) {
      if (data[i] != marker[0]) continue;
      for (var j = 1; j < marker.length; j++)
        if (data[i + j] != marker[j]) continue outer;
      start = i;
      break;
    }
    if (start < 0) _invalid('Missing startxref');
    final l = _Lexer(data, start + 9);
    readXref(_intWord(l.word()), {}, 0);
    if (trailer['Encrypt'] != null)
      throw const PdfException(
        'ENCRYPTED_PDF',
        'Encrypted PDFs are not supported',
      );
  }
  void check() {
    if (options.cancelled?.call() == true ||
        (options.timeout != null && clock.elapsed >= options.timeout!))
      throw const PdfException('ABORTED', 'PDF extraction cancelled');
  }

  void warn(String code, int page, String message) {
    out.complete = false;
    if (out.warnings.length >= 1000) return;
    final key = '$code:$page:$message';
    if (!warned.add(key)) return;
    out.warnings.add(Warning(code, page, message));
  }

  _Dict dict(Object? v) => _asDict(resolve(v));
  List<Object?> array(Object? v) => _asArray(resolve(v));
  void putXref(int id, _XEntry entry) {
    if (id < 0 || id > limits.objects * 10) _limit();
    xref.putIfAbsent(id, () => entry);
    if (xref.length > limits.objects) _limit();
  }

  void readXref(int off, Set<int> seen, int depth) {
    check();
    if (off < 0 || off >= data.length || seen.contains(off))
      _invalid('Cyclic or invalid xref');
    if (depth > 64) _limit();
    seen.add(off);
    final l = _Lexer(data, off);
    late _Dict next;
    if (l.word() == 'xref') {
      while (true) {
        final word = l.word();
        if (word == 'trailer') {
          next = _asDict(l.value());
          break;
        }
        final first = _intWord(word), count = _intWord(l.word());
        if (count < 0 || count > limits.objects) _limit();
        for (var i = 0; i < count; i++) {
          final offset = _intWord(l.word()),
              gen = _intWord(l.word()),
              flag = l.word();
          if (flag != 'n' && flag != 'f') _invalid('Invalid xref entry');
          putXref(first + i, _XEntry(flag == 'n' ? 1 : 0, offset, gen));
        }
      }
    } else {
      final s = indirect(off).$2;
      if (s is! _Stream || _named(s.dict['Type']) != 'XRef')
        _invalid('Expected xref stream');
      next = s.dict;
      final b = decode(s), w = _asArray(next['W']);
      if (w.length != 3) _invalid('Invalid xref widths');
      final widths = w.map(_integer).toList();
      var row = 0;
      for (final n in widths) {
        if (n < 0 || n > 8) _invalid();
        row += n;
      }
      if (row == 0) _invalid();
      var indices = _asArray(next['Index']);
      if (indices.isEmpty) indices = [0, next['Size']];
      if (indices.length.isOdd) _invalid();
      var pos = 0;
      for (var i = 0; i < indices.length; i += 2) {
        final first = _integer(indices[i]), count = _integer(indices[i + 1]);
        if (count < 0 ||
            count > limits.objects ||
            count > (b.length - pos) / row)
          _invalid();
        for (var j = 0; j < count; j++) {
          final fields = [0, 0, 0];
          for (var k = 0; k < 3; k++)
            for (var z = 0; z < widths[k]; z++) {
              fields[k] = fields[k] * 256 + b[pos++];
              if (fields[k] > 9007199254740991) _limit();
            }
          if (widths[0] == 0) fields[0] = 1;
          putXref(first + j, _XEntry(fields[0], fields[1], fields[2]));
        }
      }
    }
    for (final entry in next.entries)
      trailer.putIfAbsent(entry.key, () => entry.value);
    if (next.containsKey('XRefStm'))
      readXref(_integer(next['XRefStm']), seen, depth + 1);
    if (next.containsKey('Prev'))
      readXref(_integer(next['Prev']), seen, depth + 1);
  }

  (_Ref, Object?) indirect(int off) {
    if (off < 0 || off >= data.length) _invalid();
    final l = _Lexer(data, off),
        id = _intWord(l.word()),
        gen = _intWord(l.word());
    if (l.word() != 'obj') _invalid('Invalid object at $off');
    final ref = _Ref(id, gen);
    var v = l.value();
    l.skip();
    if (v is _Dict && l.word() == 'stream') {
      final d = v;
      if (l.at(l.pos) == 13) l.pos++;
      if (l.at(l.pos) == 10) {
        l.pos++;
      } else if (l.pos == 0 || l.at(l.pos - 1) != 13) {
        _invalid('Missing stream newline');
      }
      final length = resolve(d['Length']);
      if (length is! num ||
          length != length.truncateToDouble() ||
          length < 0 ||
          length > data.length - l.pos)
        _invalid('Invalid stream length');
      final n = length.toInt(), raw = _slice(data, l.pos, l.pos + n);
      l.pos += n;
      if (l.word() != 'endstream') _invalid('Missing endstream');
      v = _Stream(d, raw);
    }
    return (ref, v);
  }

  Object? resolve(Object? v) {
    for (var i = 0; i < 64; i++) {
      if (v is! _Ref) return v;
      v = get(v);
    }
    return _invalid('Reference cycle');
  }

  Object? get(_Ref r) {
    if (objects.containsKey(r)) return objects[r];
    if (!loading.add(r)) _invalid('Object cycle');
    try {
      final e = xref[r.id];
      if (e == null || e.type == 0) return null;
      if (e.type == 1) {
        if (r.gen != e.gen) return null;
        final (actual, v) = indirect(e.offset);
        if (actual != r) _invalid('Object identity mismatch');
        objects[r] = v;
        return v;
      }
      if (e.type != 2 || r.gen != 0) _invalid('Invalid xref entry type');
      if (objectStreams.add(e.offset)) {
        final s = get(_Ref(e.offset, 0));
        if (s is! _Stream) _invalid('Missing object stream');
        final b = decode(s),
            n = _integer(s.dict['N']),
            first = _integer(s.dict['First']);
        if (_named(s.dict['Type']) != 'ObjStm' ||
            n < 0 ||
            n > limits.objects ||
            first < 0 ||
            first > b.length)
          _invalid();
        final l = _Lexer(_slice(b, 0, first)), pairs = <(int, int)>[];
        for (var j = 0; j < n; j++) {
          final id = _intWord(l.word()), pos = _intWord(l.word());
          if (pos < 0 || pos >= b.length - first) _invalid();
          pairs.add((id, pos));
        }
        for (var i = 0; i < pairs.length; i++) {
          final (id, pos) = pairs[i];
          final x = xref[id];
          if (x == null || x.type != 2 || x.offset != e.offset || x.gen != i)
            continue;
          objects[_Ref(id, 0)] = _Lexer(b, first + pos).value();
        }
      }
      return objects[r];
    } finally {
      loading.remove(r);
    }
  }

  Uint8List decode(_Stream s) {
    final cached = decoded[s];
    if (cached != null) return cached;
    final (b, terminal) = decodeFilters(s);
    if (terminal.isNotEmpty)
      _unsupported('Unsupported stream filter $terminal');
    decoded[s] = b;
    return b;
  }

  (Uint8List, String) decodeFilters(_Stream s) {
    final filter = resolve(s.dict['Filter']),
        parameters = resolve(s.dict['DecodeParms']),
        filters = filter is _Name ? [filter] : _asArray(filter),
        params = parameters is List<Object?>
            ? parameters
            : parameters != null
            ? [parameters]
            : <Object?>[];
    var b = s.raw;
    for (var i = 0; i < filters.length; i++) {
      check();
      final kind = _named(resolve(filters[i])),
          d = dict(i < params.length ? params[i] : null),
          maximum = limits.decodedBytes - decodedSize;
      switch (kind) {
        case 'FlateDecode':
        case 'Fl':
          b = _inflate(b, maximum);
        case 'ASCII85Decode':
        case 'A85':
          b = _ascii85(b, maximum);
        case 'ASCIIHexDecode':
        case 'AHx':
          b = _asciiHex(b, maximum);
        case 'RunLengthDecode':
        case 'RL':
          b = _runLength(b, maximum);
        case 'LZWDecode':
        case 'LZW':
          b = _lzwDecode(
            b,
            maximum,
            d.containsKey('EarlyChange') ? _integer(d['EarlyChange']) : 1,
          );
        case 'DCTDecode':
        case 'DCT':
        case 'JPXDecode':
        case 'CCITTFaxDecode':
        case 'CCF':
        case 'JBIG2Decode':
          if (i != filters.length - 1)
            _unsupported('Unsupported image filter chain');
          return (b, kind);
        default:
          _unsupported('Unsupported stream filter $kind');
      }
      if (const ['FlateDecode', 'Fl', 'LZWDecode', 'LZW'].contains(kind))
        b = _predict(b, d, maximum);
      decodedSize += b.length;
      if (decodedSize > limits.decodedBytes) _limit();
    }
    if (filters.isEmpty) {
      decodedSize += b.length;
      if (decodedSize > limits.decodedBytes) _limit();
    }
    return (b, '');
  }
}
