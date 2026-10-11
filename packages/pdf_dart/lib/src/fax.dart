part of pdf_extractor;

class _FaxNode {
  final next = [0, 0];
  int run = -1;
}

List<_FaxNode> _faxTree(String table) {
  final nodes = [_FaxNode()],
      fields = '$table\n$_faxSharedCodes'.trim().split(RegExp(r'\s+'));
  for (var i = 0; i < fields.length; i += 2) {
    var at = 0;
    for (final c in fields[i].codeUnits) {
      final bit = c - 48;
      if (nodes[at].next[bit] == 0) {
        nodes[at].next[bit] = nodes.length;
        nodes.add(_FaxNode());
      }
      at = nodes[at].next[bit];
    }
    nodes[at].run = int.parse(fields[i + 1]);
  }
  return nodes;
}

final _faxTrees = [_faxTree(_faxWhiteCodes), _faxTree(_faxBlackCodes)];

class _FaxBits {
  final Uint8List data;
  int at = 0;
  _FaxBits(this.data);
  int bit() {
    if (at ~/ 8 >= data.length) _invalid('Truncated CCITT stream');
    final v = (data[at ~/ 8] >> (7 - at % 8)) & 1;
    at++;
    return v;
  }

  bool eol() {
    final old = at;
    try {
      for (var n = 0; n < 128; n++) {
        final v = bit();
        if (v == 1) {
          if (n >= 11) return true;
          break;
        }
      }
    } catch (_) {}
    at = old;
    return false;
  }

  int run(int black, int remaining) {
    var total = 0;
    for (var count = 0; count <= remaining ~/ 64 + 1; count++) {
      var at = 0;
      final t = _faxTrees[black];
      while (t[at].run < 0) {
        at = t[at].next[bit()];
        if (at == 0) _invalid('Invalid CCITT code');
      }
      final n = t[at].run;
      if (n > remaining - total) _invalid('CCITT row overflow');
      total += n;
      if (n < 64) return total;
    }
    return _invalid('Invalid CCITT run');
  }

  int mode() {
    var code = 0;
    for (var n = 1; n <= 7; n++) {
      code = code * 2 + bit();
      if (n == 1 && code == 1) return 0;
      if (n == 3) {
        if (code == 1) return 10;
        if (code == 2) return -1;
        if (code == 3) return 1;
      }
      if (n == 4 && code == 1) return 20;
      if (n == 6) {
        if (code == 2) return -2;
        if (code == 3) return 2;
      }
      if (n == 7) {
        if (code == 2) return -3;
        if (code == 3) return 3;
        if (code == 1) _unsupported('Unsupported CCITT extension mode');
      }
    }
    return _invalid('Invalid CCITT mode');
  }
}

void _paintBlack(Uint8List row, int start, int end) {
  while (start < end && start % 8 != 0) {
    row[start ~/ 8] |= 1 << (7 - start % 8);
    start++;
  }
  while (start + 8 <= end) {
    row[start ~/ 8] = 255;
    start += 8;
  }
  while (start < end) {
    row[start ~/ 8] |= 1 << (7 - start % 8);
    start++;
  }
}

Uint8List _decodeFax(
  Uint8List data,
  int w,
  int h,
  int k,
  bool eol,
  bool align,
  int maximum, [
  void Function()? check,
]) {
  final stride = (w + 7) ~/ 8;
  if (w < 1 ||
      h < 1 ||
      w > (1 << 24) ||
      stride > maximum / h ||
      w + 2 > (maximum - stride * h) / 16)
    _limit();
  final out = Uint8List(stride * h), bits = _FaxBits(data);
  var reference = Int32List(w + 2),
      current = Int32List(w + 2),
      referenceLength = 2;
  reference[0] = reference[1] = w;
  for (var y = 0; y < h; y++) {
    check?.call();
    var oneD = k == 0;
    if (k >= 0) {
      var hasEOL = bits.eol();
      if (!hasEOL && align) {
        bits.at = ((bits.at + 7) ~/ 8) * 8;
        hasEOL = bits.eol();
      }
      if (eol && !hasEOL) _invalid('CCITT EOL');
      if (k > 0) oneD = bits.bit() == 1;
    } else if (align) {
      bits.at = ((bits.at + 7) ~/ 8) * 8;
    }
    final row = _slice(out, y * stride, (y + 1) * stride);
    var a0 = 0, black = 0, initial = true, length = 0;
    void append(int n) {
      if (length >= current.length) _invalid('CCITT transition overflow');
      current[length++] = n;
    }

    for (var steps = 0; a0 < w; steps++) {
      if (steps > 2 * w + 2) _invalid('CCITT step limit');
      if (steps % 256 == 0) check?.call();
      if (oneD) {
        final run = bits.run(black, w - a0);
        if (run == 0 && steps != 0) _invalid('Interior zero CCITT run');
        if (black == 1) _paintBlack(row, a0, a0 + run);
        a0 += run;
        append(a0);
        black ^= 1;
        continue;
      }
      final mode = bits.mode();
      if (mode == 10) {
        final first = bits.run(black, w - a0),
            second = bits.run(black ^ 1, w - a0 - first);
        if (first + second == 0 ||
            first == 0 && !initial ||
            second == 0 && a0 + first < w)
          _invalid('Invalid CCITT horizontal run');
        if (black == 1) {
          _paintBlack(row, a0, a0 + first);
        } else {
          _paintBlack(row, a0 + first, a0 + first + second);
        }
        append(a0 + first);
        append(a0 + first + second);
        a0 += first + second;
      } else {
        final threshold = initial ? 0 : a0 + 1;
        var lo = 0, hi = referenceLength;
        while (lo < hi) {
          final m = (lo + hi) ~/ 2;
          if (reference[m] < threshold) {
            lo = m + 1;
          } else {
            hi = m;
          }
        }
        var j = lo;
        if (j % 2 != black) j++;
        final b1 = j < referenceLength ? reference[j] : w;
        var end = b1 + mode;
        if (mode == 20) end = j + 1 < referenceLength ? reference[j + 1] : w;
        if (end < a0 || end > w || end == a0 && !initial)
          _invalid('Invalid CCITT vertical run');
        if (black == 1) _paintBlack(row, a0, end);
        a0 = end;
        if (mode != 20) {
          append(a0);
          black ^= 1;
        }
      }
      initial = false;
    }
    while (length > 0 && current[length - 1] == w) length--;
    append(w);
    append(w);
    final old = reference;
    reference = current;
    current = old;
    referenceLength = length;
  }
  return out;
}
