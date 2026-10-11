part of pdf_extractor;

class _ByteSink {
  final int maximum;
  Uint8List data;
  int length = 0;
  _ByteSink(this.maximum, [int initial = 4096])
    : data = Uint8List(math.max(0, math.min(initial, maximum))) {
    if (maximum < 0) _limit();
  }
  void reserve(int n) {
    if (n < 0 || n > maximum - length) _limit();
    if (length + n <= data.length) return;
    final next = Uint8List(
      math.min(maximum, math.max(length + n, math.max(data.length * 2, 64))),
    );
    next.setRange(0, length, data);
    data = next;
  }

  void push(int n) {
    reserve(1);
    data[length++] = n;
  }

  void append(List<int> b) {
    reserve(b.length);
    data.setRange(length, length + b.length, b);
    length += b.length;
  }

  void repeat(int value, int count) {
    reserve(count);
    data.fillRange(length, length + count, value);
    length += count;
  }

  void backref(int distance, int count) {
    if (distance < 1 || distance > length) _invalid('Invalid deflate distance');
    reserve(count);
    for (var j = 0; j < count; j++) {
      data[length] = data[length - distance];
      length++;
    }
  }

  Uint8List finish() => Uint8List.fromList(_slice(data, 0, length));
}

class _DeflateBits {
  final Uint8List data;
  int pos = 16;
  _DeflateBits(this.data);
  int peek(int n) {
    final at = pos >> 3;
    var value = data[at] >> (pos & 7);
    if (at + 1 < data.length) value |= data[at + 1] << (8 - (pos & 7));
    if (at + 2 < data.length) value |= data[at + 2] << (16 - (pos & 7));
    return value & ((1 << n) - 1);
  }

  int bits(int n) {
    if (n == 0) return 0;
    if (pos + n > data.length * 8) _invalid('Truncated deflate stream');
    final value = peek(n);
    pos += n;
    return value;
  }
}

class _Huffman {
  final fast = Uint32List(512);
  final List<Map<int, int>> tables = List.generate(16, (_) => <int, int>{});
  _Huffman(List<int> lengths) {
    final counts = List.filled(16, 0), next = List.filled(16, 0);
    for (final n in lengths) {
      if (n < 0 || n > 15) _invalid();
      if (n > 0) counts[n]++;
    }
    var code = 0;
    for (var n = 1; n <= 15; n++) {
      code = (code + counts[n - 1]) << 1;
      if (code + counts[n] > (1 << n)) _invalid('Oversubscribed Huffman tree');
      next[n] = code;
    }
    for (var symbol = 0; symbol < lengths.length; symbol++) {
      final length = lengths[symbol];
      if (length == 0) continue;
      var code = next[length]++, reversed = 0;
      for (var n = 0; n < length; n++) {
        reversed = reversed * 2 + (code & 1);
        code >>= 1;
      }
      tables[length][reversed] = symbol;
      if (length <= 9)
        for (var i = reversed; i < 512; i += 1 << length)
          fast[i] = (length << 16) | (symbol + 1);
    }
  }
  int symbol(_DeflateBits b) {
    if (b.pos + 9 <= b.data.length * 8) {
      final entry = fast[b.peek(9)];
      if (entry != 0) {
        b.pos += entry >> 16;
        return (entry & 65535) - 1;
      }
    }
    var code = 0;
    for (var n = 1; n <= 15; n++) {
      code |= b.bits(1) << (n - 1);
      final value = tables[n][code];
      if (value != null) return value;
    }
    return _invalid('Invalid Huffman code');
  }
}

final _fixedLiteral = _Huffman(
  List.generate(
    288,
    (n) => n < 144
        ? 8
        : n < 256
        ? 9
        : n < 280
        ? 7
        : 8,
  ),
);
final _fixedDistance = _Huffman(List.filled(32, 5));
// Returns the exact end of this zlib member so inline PDF images never rely on
// searching arbitrary compressed bytes for an EI token.
(Uint8List, int) _inflateMember(Uint8List b, int maximum) {
  if (b.length < 6 ||
      (b[0] & 15) != 8 ||
      b[0] >> 4 > 7 ||
      (b[0] * 256 + b[1]) % 31 != 0 ||
      (b[1] & 32) != 0)
    _invalid('Invalid zlib header');
  final reader = _DeflateBits(b), out = _ByteSink(maximum);
  const lengthBase = [
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        13,
        15,
        17,
        19,
        23,
        27,
        31,
        35,
        43,
        51,
        59,
        67,
        83,
        99,
        115,
        131,
        163,
        195,
        227,
        258,
      ],
      lengthExtra = [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        3,
        3,
        3,
        3,
        4,
        4,
        4,
        4,
        5,
        5,
        5,
        5,
        0,
      ],
      distanceBase = [
        1,
        2,
        3,
        4,
        5,
        7,
        9,
        13,
        17,
        25,
        33,
        49,
        65,
        97,
        129,
        193,
        257,
        385,
        513,
        769,
        1025,
        1537,
        2049,
        3073,
        4097,
        6145,
        8193,
        12289,
        16385,
        24577,
      ],
      order = [
        16,
        17,
        18,
        0,
        8,
        7,
        9,
        6,
        10,
        5,
        11,
        4,
        12,
        3,
        13,
        2,
        14,
        1,
        15,
      ];
  var last = 0;
  do {
    last = reader.bits(1);
    final type = reader.bits(2);
    if (type == 0) {
      reader.pos = ((reader.pos + 7) ~/ 8) * 8;
      final length = reader.bits(16), inverse = reader.bits(16);
      if ((length ^ inverse) != 65535) _invalid();
      final at = reader.pos ~/ 8;
      if (length > b.length - at) _invalid();
      out.append(_slice(b, at, at + length));
      reader.pos += length * 8;
      continue;
    }
    late _Huffman literal, distance;
    if (type == 1) {
      literal = _fixedLiteral;
      distance = _fixedDistance;
    } else if (type == 2) {
      final nl = reader.bits(5) + 257,
          nd = reader.bits(5) + 1,
          nc = reader.bits(4) + 4;
      if (nl > 286 || nd > 32) _invalid();
      final lengths = List.filled(19, 0);
      for (var j = 0; j < nc; j++) lengths[order[j]] = reader.bits(3);
      final codes = _Huffman(lengths), all = <int>[];
      while (all.length < nl + nd) {
        final n = codes.symbol(reader);
        if (n < 16) {
          all.add(n);
        } else {
          final count = n == 16
              ? reader.bits(2) + 3
              : n == 17
              ? reader.bits(3) + 3
              : reader.bits(7) + 11;
          if (n == 16 && all.isEmpty || all.length + count > nl + nd)
            _invalid();
          final v = n == 16 ? all.last : 0;
          all.addAll(List.filled(count, v));
        }
      }
      if (all[256] == 0) _invalid();
      literal = _Huffman(all.sublist(0, nl));
      distance = _Huffman(all.sublist(nl));
    } else {
      _invalid('Reserved deflate block type');
    }
    while (true) {
      final n = literal.symbol(reader);
      if (n == 256) break;
      if (n < 256) {
        out.push(n);
      } else {
        if (n > 285) _invalid();
        final length = lengthBase[n - 257] + reader.bits(lengthExtra[n - 257]),
            d = distance.symbol(reader);
        if (d > 29) _invalid();
        out.backref(
          distanceBase[d] + reader.bits(d < 4 ? 0 : (d >> 1) - 1),
          length,
        );
      }
    }
  } while (last == 0);
  final end = (reader.pos + 7) ~/ 8;
  if (end + 4 > b.length) _invalid('Missing zlib checksum');
  final result = out.finish();
  var a = 1, c = 0;
  for (var at = 0; at < result.length; at += 5552) {
    for (var j = at; j < math.min(result.length, at + 5552); j++) {
      a += result[j];
      c += a;
    }
    a %= 65521;
    c %= 65521;
  }
  final checksum =
      b[end] * 16777216 + b[end + 1] * 65536 + b[end + 2] * 256 + b[end + 3];
  if (checksum != c * 65536 + a) _invalid('Invalid zlib checksum');
  return (result, end + 4);
}

Uint8List _inflate(Uint8List b, int maximum) => _inflateMember(b, maximum).$1;
Uint8List _asciiHex(Uint8List b, int maximum) {
  final h = StringBuffer();
  for (final c in b) {
    if (c == 62) break;
    if (!_white(c)) h.writeCharCode(c);
    if (h.length > maximum * 2) _limit();
  }
  var s = h.toString();
  if (s.length.isOdd) s += '0';
  return _hexDecode(s);
}

Uint8List _ascii85(Uint8List b, int maximum) {
  final out = _ByteSink(maximum);
  var n = 0, count = 0;
  for (var pos = 0; pos < b.length; pos++) {
    final c = b[pos];
    if (_white(c)) continue;
    if (c == 126 && pos + 1 < b.length && b[pos + 1] == 62) break;
    if (c == 122) {
      if (count != 0) _invalid('Invalid ASCII85 zero tuple');
      out.repeat(0, 4);
      continue;
    }
    if (c < 33 || c > 117) _invalid('Invalid ASCII85 digit');
    n = n * 85 + c - 33;
    count++;
    if (count == 5) {
      if (n > 0xffffffff) _invalid('ASCII85 overflow');
      out.append([
        n ~/ 16777216,
        (n ~/ 65536) & 255,
        (n ~/ 256) & 255,
        n & 255,
      ]);
      n = count = 0;
    }
  }
  if (count == 1) _invalid('Truncated ASCII85 tuple');
  if (count > 0) {
    final length = count - 1;
    while (count++ < 5) n = n * 85 + 84;
    for (var i = 0; i < length; i++)
      out.push((n ~/ math.pow(2, 24 - i * 8)) & 255);
  }
  return out.finish();
}

Uint8List _runLength(Uint8List b, int maximum) {
  final out = _ByteSink(maximum);
  for (var i = 0; i < b.length;) {
    final n = b[i++];
    if (n == 128) return out.finish();
    final count = n < 128 ? n + 1 : 257 - n;
    if (n < 128) {
      if (count > b.length - i) _invalid();
      out.append(_slice(b, i, i + count));
      i += count;
    } else {
      if (i == b.length) _invalid();
      out.repeat(b[i++], count);
    }
  }
  return _invalid('Unterminated RunLength stream');
}

Uint8List _lzwDecode(Uint8List b, int maximum, [int early = 1]) {
  if (early != 0 && early != 1) _invalid('Invalid LZW EarlyChange');
  final table = List<Uint8List?>.filled(4096, null);
  for (var i = 0; i < 256; i++) table[i] = Uint8List.fromList([i]);
  var bits = 9, next = 258, pos = 0;
  Uint8List? previous;
  final out = _ByteSink(maximum);
  while (pos + bits <= b.length * 8) {
    var code = 0;
    for (var j = 0; j < bits; j++, pos++)
      code = code * 2 + ((b[pos ~/ 8] >> (7 - pos % 8)) & 1);
    if (code == 256) {
      bits = 9;
      next = 258;
      previous = null;
      continue;
    }
    if (code == 257) return out.finish();
    Uint8List? entry;
    if (code < next) {
      entry = table[code];
    } else if (code == next && previous != null && previous.isNotEmpty) {
      entry = Uint8List(previous.length + 1)
        ..setRange(0, previous.length, previous);
      entry[previous.length] = previous[0];
    } else {
      _invalid('Invalid LZW code');
    }
    if (entry == null || entry.isEmpty) _invalid('Empty LZW entry');
    out.append(entry);
    if (previous != null && previous.isNotEmpty && next < 4096) {
      final added = Uint8List(previous.length + 1)
        ..setRange(0, previous.length, previous);
      added[previous.length] = entry[0];
      table[next++] = added;
      if (bits < 12 && next + early == (1 << bits)) bits++;
    }
    previous = entry;
  }
  return _invalid('Truncated LZW stream');
}

int _paeth(int a, int b, int c) {
  final p = a + b - c, x = (p - a).abs(), y = (p - b).abs(), z = (p - c).abs();
  return x <= y && x <= z
      ? a
      : y <= z
      ? b
      : c;
}

Uint8List _predict(Uint8List b, _Dict d, int maximum) {
  final pred = _integer(d['Predictor']);
  if (pred <= 1) return b;
  var colors = _integer(d['Colors']),
      cols = _integer(d['Columns']),
      bits = _integer(d['BitsPerComponent']);
  if (colors == 0) colors = 1;
  if (cols == 0) cols = 1;
  if (bits == 0) bits = 8;
  if (colors < 1 ||
      colors > 32 ||
      cols < 1 ||
      cols > 1000000 ||
      bits < 1 ||
      bits > 16)
    _limit();
  final row = (colors * cols * bits + 7) ~/ 8, bpp = (colors * bits + 7) ~/ 8;
  if (row > maximum) _limit();
  if (pred == 2) {
    if (bits != 8) _unsupported('Unsupported TIFF predictor bit depth $bits');
    if (b.length % row != 0) _invalid('Invalid TIFF predictor');
    final out = Uint8List.fromList(b);
    for (var y = 0; y < out.length; y += row)
      for (var x = colors; x < row; x++) out[y + x] += out[y + x - colors];
    return out;
  }
  if (pred < 10 || pred > 15 || b.length % (row + 1) != 0)
    _invalid('Invalid predictor');
  final out = Uint8List(b.length ~/ (row + 1) * row);
  for (var y = 0, pos = 0; pos < b.length; y += row, pos += row + 1) {
    final f = b[pos];
    if (f > 4) _invalid('Invalid PNG predictor');
    for (var x = 0; x < row; x++) {
      var v = b[pos + 1 + x];
      final a = x >= bpp ? out[y + x - bpp] : 0,
          u = y > 0 ? out[y - row + x] : 0,
          c = y > 0 && x >= bpp ? out[y - row + x - bpp] : 0;
      if (f == 1)
        v += a;
      else if (f == 2)
        v += u;
      else if (f == 3)
        v += (a + u) ~/ 2;
      else if (f == 4)
        v += _paeth(a, u, c);
      out[y + x] = v;
    }
  }
  return out;
}
