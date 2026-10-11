part of pdf_extractor;

Uint8List _sfntTable(Uint8List b, String name) {
  if (b.length < 12) _invalid();
  final n = _u16(b, 4);
  if (n > 4096 || n * 16 > b.length - 12) _invalid();
  for (var j = 0; j < n; j++) {
    final at = 12 + j * 16;
    if (_binary(_slice(b, at, at + 4)) != name) continue;
    final start = _u32(b, at + 8), length = _u32(b, at + 12);
    if (start > b.length || length > b.length - start) _invalid();
    return _slice(b, start, start + length);
  }
  return _invalid('Missing font table $name');
}

class _TTPoint {
  double x, y;
  bool on;
  _TTPoint(this.x, this.y, this.on);
}

class _TrueTypeFont {
  late final int glyphs;
  late final bool long;
  late final double units;
  late final Uint8List glyf, loca, cmap;
  _TrueTypeFont(Uint8List b) {
    final head = _sfntTable(b, 'head'), maxp = _sfntTable(b, 'maxp');
    if (head.length < 54 || maxp.length < 6) _invalid();
    glyphs = _u16(maxp, 4);
    long = _u16(head, 50) == 1;
    units = _u16(head, 18).toDouble();
    if (units < 16 || units > 16384 || glyphs < 1) _invalid();
    glyf = _sfntTable(b, 'glyf');
    loca = _sfntTable(b, 'loca');
    if (loca.length < (glyphs + 1) * (long ? 4 : 2)) _invalid();
    Uint8List cm;
    try {
      cm = _sfntTable(b, 'cmap');
    } catch (_) {
      cm = Uint8List(0);
    }
    cmap = cm;
  }
  int lookup(int r) {
    final b = cmap;
    if (b.length < 4) return 0;
    final n = _u16(b, 2);
    if (n * 8 > b.length - 4) return 0;
    for (var j = 0; j < n; j++) {
      final at = _u32(b, 8 + j * 8);
      if (at + 2 > b.length) continue;
      var sub = _slice(b, at);
      final format = _u16(sub, 0);
      if (format == 4) {
        if (sub.length < 16 || r > 65535) continue;
        final length = _u16(sub, 2);
        if (length < 16 || length > sub.length) continue;
        sub = _slice(sub, 0, length);
        final count = _u16(sub, 6) ~/ 2;
        if (count < 1 || count * 8 > sub.length - 16) continue;
        for (var k = 0; k < count; k++) {
          final end = _u16(sub, 14 + k * 2),
              start = _u16(sub, 16 + count * 2 + k * 2);
          if (r < start || r > end) continue;
          final delta = _i16(sub, 16 + count * 4 + k * 2),
              roff = 16 + count * 6 + k * 2,
              offset = _u16(sub, roff);
          var gid = r;
          if (offset > 0) {
            final pos = roff + offset + 2 * (r - start);
            if (pos < 0 || pos + 2 > sub.length) continue;
            gid = _u16(sub, pos);
            if (gid == 0) continue;
          }
          gid = (gid + delta) & 65535;
          if (gid > 0 && gid < glyphs) return gid;
        }
      } else if (format == 12) {
        if (sub.length < 16) continue;
        final count = _u32(sub, 12);
        if (count > (sub.length - 16) ~/ 12) continue;
        for (var k = 0; k < count; k++) {
          final at = 16 + k * 12,
              first = _u32(sub, at),
              last = _u32(sub, at + 4);
          if (r < first || r > last) continue;
          final gid = _u32(sub, at + 8) + r - first;
          if (gid > 0 && gid < glyphs) return gid;
        }
      }
    }
    return 0;
  }

  Uint8List data(int gid) {
    if (gid < 0 || gid >= glyphs) _invalid();
    int offset(int n) => long ? _u32(loca, n * 4) : _u16(loca, n * 2) * 2;
    final a = offset(gid), z = offset(gid + 1);
    if (a > z || z > glyf.length) _invalid();
    return _slice(glyf, a, z);
  }

  void draw(_CharString c, int gid, _Matrix m, [int depth = 0]) {
    if (++c.ops > 10000 || depth > 16) _limit();
    final b = data(gid);
    if (b.isEmpty) return;
    if (b.length < 10) _invalid();
    final contours = _i16(b, 0);
    var at = 10;
    int read() {
      final n = _u16(b, at);
      at += 2;
      return n;
    }

    int signed(int n) => n >= 32768 ? n - 65536 : n;
    if (contours < 0) {
      while (true) {
        final flags = read(), child = read();
        late int x, y;
        if ((flags & 1) != 0) {
          x = signed(read());
          y = signed(read());
        } else {
          if (at + 2 > b.length) _invalid();
          x = b[at++];
          y = b[at++];
          if (x >= 128) x -= 256;
          if (y >= 128) y -= 256;
        }
        if ((flags & 2) == 0)
          _unsupported('point-matched composite font glyph needs review');
        final cm = <double>[1, 0, 0, 1, x.toDouble(), y.toDouble()];
        double scale() => signed(read()) / 16384;
        if ((flags & 8) != 0) {
          cm[0] = cm[3] = scale();
        } else if ((flags & 64) != 0) {
          cm[0] = scale();
          cm[3] = scale();
        } else if ((flags & 128) != 0) {
          for (var j = 0; j < 4; j++) cm[j] = scale();
        }
        if ((flags & 0x800) != 0) {
          cm[4] = cm[0] * x + cm[2] * y;
          cm[5] = cm[1] * x + cm[3] * y;
        }
        draw(c, child, _mul(m, cm), depth + 1);
        if ((flags & 32) == 0) return;
      }
    }
    if (contours == 0) return;
    if (contours > 4096) _limit();
    final ends = <int>[];
    for (var j = 0; j < contours; j++) {
      final n = read();
      if (j > 0 && n <= ends[j - 1]) _invalid();
      ends.add(n);
    }
    final count = ends.last + 1;
    if (count > 20000) _limit();
    final ins = read();
    if (ins > b.length - at) _invalid();
    at += ins;
    final flags = <int>[];
    while (flags.length < count) {
      if (at >= b.length) _invalid();
      final v = b[at++];
      var repeat = 1;
      if ((v & 8) != 0) {
        if (at >= b.length) _invalid();
        repeat += b[at++];
      }
      if (repeat > count - flags.length) _invalid();
      flags.addAll(List.filled(repeat, v));
    }
    final points = List.generate(count, (_) => _TTPoint(0, 0, false));
    for (var axis = 0; axis < 2; axis++) {
      var pos = 0;
      final short = axis == 1 ? 4 : 2, same = axis == 1 ? 32 : 16;
      for (var j = 0; j < flags.length; j++) {
        final flag = flags[j];
        var delta = 0;
        if ((flag & short) != 0) {
          if (at >= b.length) _invalid();
          delta = b[at++];
          if ((flag & same) == 0) delta = -delta;
        } else if ((flag & same) == 0) {
          delta = signed(read());
        }
        pos += delta;
        if (pos.abs() > 1e7) _limit();
        if (axis == 1) {
          points[j].y = pos.toDouble();
        } else {
          points[j].x = pos.toDouble();
        }
        points[j].on = (flag & 1) != 0;
      }
    }
    void command(String op, List<_TTPoint> pts) {
      final coords = <double>[];
      for (final p in pts) {
        final (x, y) = _point(m, p.x, p.y);
        coords.addAll([x, y]);
      }
      c.point(op, coords);
    }

    _TTPoint mid(_TTPoint a, _TTPoint b) =>
        _TTPoint((a.x + b.x) / 2, (a.y + b.y) / 2, true);
    var first = 0;
    for (final end in ends) {
      var segment = points.sublist(first, end + 1);
      first = end + 1;
      final a = segment.first, z = segment.last;
      var start = a;
      if (a.on) {
        segment = segment.sublist(1);
      } else if (z.on) {
        start = z;
        segment = segment.sublist(0, segment.length - 1);
      } else {
        start = mid(z, a);
      }
      command('M', [start]);
      _TTPoint? control;
      for (final pt in segment) {
        if (pt.on) {
          if (control != null) {
            command('Q', [control, pt]);
            control = null;
          } else {
            command('L', [pt]);
          }
        } else {
          if (control != null) command('Q', [control, mid(control, pt)]);
          control = pt;
        }
      }
      if (control != null) command('Q', [control, start]);
      c.path.write('Z');
    }
  }
}
