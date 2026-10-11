part of pdf_extractor;

int _u16(Uint8List b, int at) {
  if (at < 0 || at + 2 > b.length) _invalid('Truncated font data');
  return b[at] * 256 + b[at + 1];
}

int _i16(Uint8List b, int at) {
  final n = _u16(b, at);
  return n >= 32768 ? n - 65536 : n;
}

int _u32(Uint8List b, int at) {
  if (at < 0 || at + 4 > b.length) _invalid('Truncated font data');
  return b[at] * 16777216 + b[at + 1] * 65536 + b[at + 2] * 256 + b[at + 3];
}

class _GlyphOutline {
  final String path;
  final Rect? box;
  final int operations;
  final Object? error;
  _GlyphOutline(this.path, this.box, this.operations, [this.error]);
}

class _OutlineFont {
  List<Uint8List> chars = [], global = [];
  List<List<Uint8List>> local = [];
  List<int> fd = [];
  Map<int, int> codes = {};
  Map<String, int>? names;
  _Matrix matrix = [.001, 0, 0, .001, 0, 0];
  final cache = <int, _GlyphOutline>{};
  bool type1 = false, type3 = false;
  int? glyphCount;
  void Function(_CharString, int)? draw;
  _GlyphOutline outline(int code, String name) {
    final gid = names != null ? names![name] : codes[code],
        maximum = glyphCount ?? chars.length;
    if (gid == null || gid < 0 || gid >= maximum) _invalid('Invalid glyph ID');
    final cached = cache[gid];
    if (cached != null) {
      if (cached.error != null) throw cached.error!;
      return cached;
    }
    final localID = gid < fd.length ? fd[gid] : -1,
        c = _CharString(
          this,
          localID >= 0 && localID < local.length ? local[localID] : [],
        );
    Object? error;
    try {
      if (draw != null) {
        draw!(c, gid);
      } else {
        c.run(chars[gid], 0);
        c.close();
        if (!c.done) _invalid('Unterminated charstring');
      }
    } catch (e) {
      error = e;
    }
    final result = _GlyphOutline(c.path.toString(), c.box, c.ops, error);
    cache[gid] = result;
    if (error != null) throw error;
    return result;
  }
}

(List<Uint8List>, int) _cffIndex(Uint8List b, int start) {
  var at = start;
  final n = _u16(b, at);
  at += 2;
  if (n == 0) return ([], at);
  if (at >= b.length) _invalid();
  final width = b[at++];
  if (width < 1 || width > 4 || (n + 1) * width > b.length - at) _invalid();
  final offsets = <int>[];
  for (var i = 0; i <= n; i++) {
    var value = 0;
    for (var j = 0; j < width; j++) value = value * 256 + b[at++];
    offsets.add(value);
  }
  if (offsets[0] != 1 || offsets[n] < 1 || offsets[n] - 1 > b.length - at)
    _invalid();
  final out = <Uint8List>[];
  for (var i = 0; i < n; i++) {
    if (offsets[i] < 1 ||
        offsets[i] > offsets[i + 1] ||
        offsets[i + 1] > offsets[n])
      _invalid();
    out.add(_slice(b, at + offsets[i] - 1, at + offsets[i + 1] - 1));
  }
  return (out, at + offsets[n] - 1);
}

class _Cursor {
  int at = 0;
}

double _cffNumber(Uint8List b, _Cursor cursor, bool dictMode, bool type1) {
  if (cursor.at >= b.length) _invalid();
  final v = b[cursor.at++];
  if (v >= 32 && v <= 246) return (v - 139).toDouble();
  if (v >= 247 && v <= 254) {
    if (cursor.at >= b.length) _invalid();
    final w = b[cursor.at++];
    return (v < 251 ? (v - 247) * 256 + w + 108 : -(v - 251) * 256 - w - 108)
        .toDouble();
  }
  if (v == 28) {
    final n = _i16(b, cursor.at);
    cursor.at += 2;
    return n.toDouble();
  }
  if (v == 29 && dictMode || v == 255) {
    var n = _u32(b, cursor.at);
    cursor.at += 4;
    if (n >= 2147483648) n -= 4294967296;
    return v == 255 && !type1 ? n / 65536 : n.toDouble();
  }
  if (v == 30 && dictMode) {
    var s = '';
    while (cursor.at < b.length && s.length < 64) {
      final w = b[cursor.at++];
      for (final c in [w >> 4, w & 15]) {
        if (c < 10) {
          s += '$c';
        } else if (c == 10) {
          s += '.';
        } else if (c == 11) {
          s += 'E';
        } else if (c == 12) {
          s += 'E-';
        } else if (c == 14) {
          s += '-';
        } else if (c == 15) {
          final n = double.tryParse(s);
          if (n == null || !n.isFinite) _invalid();
          return n;
        } else {
          _invalid();
        }
      }
    }
  }
  return _invalid('Invalid CFF number');
}

Map<int, List<double>> _cffDict(Uint8List b) {
  final d = <int, List<double>>{}, cursor = _Cursor();
  var stack = <double>[];
  while (cursor.at < b.length) {
    final v = b[cursor.at];
    if (v >= 28) {
      stack.add(_cffNumber(b, cursor, true, false));
      if (stack.length > 64) _limit();
      continue;
    }
    cursor.at++;
    var op = v;
    if (v == 12) {
      if (cursor.at == b.length) _invalid();
      op = 1200 + b[cursor.at++];
    }
    d[op] = stack;
    stack = [];
  }
  return d;
}

int _cffInt(Map<int, List<double>> d, int k) {
  final a = d[k];
  if (a == null || a.isEmpty || a[0].abs() >= (1 << 30)) return 0;
  return a[0].truncate();
}

void _namedCharset(
  _OutlineFont f,
  Uint8List b,
  Map<int, List<double>> d,
  List<Uint8List> custom,
) {
  String nameFor(int sid) {
    if (sid < 0 || sid >= 65000) _invalid();
    if (sid < _cffStrings.length) return _cffStrings[sid];
    sid -= _cffStrings.length;
    if (sid >= custom.length || custom[sid].isEmpty || custom[sid].length > 127)
      _invalid();
    return _binary(custom[sid]);
  }

  f.names = {'.notdef': 0};
  final charset = List.filled(f.chars.length, 0);
  var at = _cffInt(d, 15);
  if (at >= 0 && at <= 2) {
    final predefined = at == 1
        ? _cffExpert
        : at == 2
        ? _cffExpertSubset
        : _cffStrings.sublist(0, 229);
    if (f.chars.length > predefined.length) _invalid();
    for (var gid = 0; gid < f.chars.length; gid++) {
      final name = predefined[gid];
      f.names![name] = gid;
      final sid = _cffStrings.indexOf(name);
      if (sid >= 0) charset[gid] = sid;
    }
  } else {
    if (at < 3 || at >= b.length) _invalid();
    final format = b[at++];
    for (var gid = 1; gid < f.chars.length;) {
      final first = _u16(b, at);
      at += 2;
      var n = 0;
      if (format == 1) {
        if (at >= b.length) _invalid();
        n = b[at++];
      } else if (format == 2) {
        n = _u16(b, at);
        at += 2;
      } else if (format != 0) {
        _invalid();
      }
      if (n >= f.chars.length - gid) _invalid();
      for (var j = 0; j <= n; j++) {
        final name = nameFor(first + j);
        if (f.names!.containsKey(name)) _invalid();
        charset[gid] = first + j;
        f.names![name] = gid++;
      }
    }
  }
  at = _cffInt(d, 16);
  if (at == 0) {
    for (var code = 0; code < _cffStandardEncoding.length; code++) {
      final name = _cffStandardEncoding[code], gid = f.names![name];
      if (gid != null && name != '.notdef') f.codes[code] = gid;
    }
    return;
  }
  if (at == 1) _unsupported('CFF ExpertEncoding is unsupported');
  if (at < 2 || at + 2 > b.length) _invalid();
  final format = b[at++], n = b[at++];
  void set(int code, int gid) {
    if (code > 255 || gid >= f.chars.length || f.codes.containsKey(code))
      _invalid();
    f.codes[code] = gid;
  }

  if ((format & 127) == 0) {
    if (n > b.length - at) _invalid();
    for (var j = 0; j < n; j++) set(b[at + j], j + 1);
    at += n;
  } else if ((format & 127) == 1) {
    if (n * 2 > b.length - at) _invalid();
    var gid = 1;
    for (var j = 0; j < n; j++) {
      final first = b[at++], last = b[at++];
      for (var k = 0; k <= last; k++) set(first + k, gid++);
    }
  } else {
    _invalid();
  }
  if ((format & 128) != 0) {
    if (at >= b.length) _invalid();
    final n = b[at++];
    if (n * 3 > b.length - at) _invalid();
    final bySID = <int, int>{};
    for (var gid = 0; gid < charset.length; gid++) bySID[charset[gid]] = gid;
    for (var j = 0; j < n; j++) {
      final code = b[at++], sid = _u16(b, at);
      at += 2;
      final gid = bySID[sid];
      if (gid == null || f.codes.containsKey(code)) _invalid();
      f.codes[code] = gid;
    }
  }
}

_OutlineFont _parseCFF(Uint8List b) {
  if (b.length < 4 || b[0] != 1 || b[2] < 4 || b[2] > b.length) _invalid();
  var at = _cffIndex(b, b[2]).$2;
  final (top, next) = _cffIndex(b, at);
  if (top.length != 1) _invalid();
  at = next;
  final (custom, next2) = _cffIndex(b, at);
  at = next2;
  final global = _cffIndex(b, at).$1,
      d = _cffDict(top[0]),
      chars = _cffIndex(b, _cffInt(d, 17)).$1;
  if (chars.isEmpty) _invalid();
  final f = _OutlineFont()
    ..chars = chars
    ..global = global
    ..fd = List.filled(chars.length, 0);
  final matrix = d[1207];
  if (matrix?.length == 6) {
    f.matrix = List.from(matrix!);
    _validMatrix(f.matrix);
  }
  List<Uint8List> local(Map<int, List<double>> dict) {
    final a = dict[18];
    if (a?.length != 2) return [];
    if (a!.any((n) => n < 0 || n > b.length)) _invalid();
    final size = a[0].truncate(), start = a[1].truncate();
    if (size > b.length - start) _invalid();
    final priv = _cffDict(_slice(b, start, start + size)),
        off = _cffInt(priv, 19);
    return off != 0 ? _cffIndex(b, start + off).$1 : [];
  }

  if (d.containsKey(1230)) {
    final dicts = _cffIndex(b, _cffInt(d, 1236)).$1;
    if (dicts.isEmpty || dicts.length > 256) _invalid();
    for (final raw in dicts) {
      final fd = _cffDict(raw);
      if (fd[1207]?.isNotEmpty == true)
        _unsupported('CFF FD FontMatrix not supported');
      f.local.add(local(fd));
    }
    at = _cffInt(d, 1237);
    if (at < 0 || at >= b.length) _invalid();
    var format = b[at++];
    if (format == 0) {
      if (chars.length > b.length - at) _invalid();
      for (var j = 0; j < f.fd.length; j++) f.fd[j] = b[at + j];
    } else if (format == 3) {
      final n = _u16(b, at);
      at += 2;
      if (n < 1 || n * 3 + 2 > b.length - at) _invalid();
      for (var j = 0; j < n; j++) {
        final start = _u16(b, at + j * 3),
            end = _u16(b, at + (j + 1) * 3),
            fd = b[at + j * 3 + 2];
        if (start >= end ||
            end > chars.length ||
            j == 0 && start != 0 ||
            j == n - 1 && end != chars.length)
          _invalid();
        for (var k = start; k < end; k++) f.fd[k] = fd;
      }
    } else {
      _invalid();
    }
    if (f.fd.any((fd) => fd >= f.local.length)) _invalid();
    at = _cffInt(d, 15);
    if (at < 3 || at >= b.length) _invalid();
    format = b[at++];
    for (var gid = 1; gid < chars.length;) {
      final first = _u16(b, at);
      at += 2;
      var n = 0;
      if (format == 1) {
        if (at >= b.length) _invalid();
        n = b[at++];
      } else if (format == 2) {
        n = _u16(b, at);
        at += 2;
      } else if (format != 0) {
        _invalid();
      }
      if (n >= chars.length - gid || first + n > 65535) _invalid();
      for (var j = 0; j <= n; j++) f.codes[first + j] = gid++;
    }
  } else {
    f.local = [local(d)];
    _namedCharset(f, b, d, custom);
  }
  return f;
}

int _subrBias(int n) => n < 1240
    ? 107
    : n < 33900
    ? 1131
    : 32768;

class _CharString {
  final _OutlineFont font;
  final List<Uint8List> local;
  List<double> stack = [];
  double x = 0, y = 0;
  int stems = 0, ops = 0;
  final path = StringBuffer();
  bool open = false, done = false, flex = false;
  List<(double, double)> flexPoints = [];
  List<double> others = [];
  Rect? box;
  _CharString(this.font, [this.local = const []]);
  void close() {
    if (open) {
      path.write('Z');
      open = false;
    }
  }

  void point(String op, List<double> v) {
    if (++ops > 100000 || v.any((n) => !n.isFinite || n.abs() > 1e7)) _limit();
    for (var j = 0; j + 1 < v.length; j += 2) {
      final r = Rect(v[j], v[j + 1], 0, 0);
      box = box == null ? r : _union(box!, r);
    }
    path.write(op);
    for (final n in v) path.write('${_fnum(n)} ');
    if (path.length > (1 << 20)) _limit();
  }

  void move(double dx, double dy) {
    if (flex) {
      x += dx;
      y += dy;
      return;
    }
    close();
    x += dx;
    y += dy;
    open = true;
    point('M', [x, y]);
  }

  void line(double dx, double dy) {
    x += dx;
    y += dy;
    point('L', [x, y]);
  }

  void curve(List<double> v) {
    final x1 = x + v[0], y1 = y + v[1], x2 = x1 + v[2], y2 = y1 + v[3];
    x = x2 + v[4];
    y = y2 + v[5];
    point('C', [x1, y1, x2, y2, x, y]);
  }

  void run(Uint8List b, int depth) {
    if (depth > 16) _limit();
    final cursor = _Cursor();
    while (cursor.at < b.length && !done) {
      if (++ops > 100000) _limit();
      var op = b[cursor.at];
      if (op >= 32 || op == 28) {
        stack.add(_cffNumber(b, cursor, false, font.type1));
        if (stack.length > 96) _limit();
        continue;
      }
      cursor.at++;
      if (op == 12) {
        if (cursor.at == b.length) _invalid();
        op = 1200 + b[cursor.at++];
      }
      var a = stack, n = a.length;
      switch (op) {
        case 1:
        case 3:
        case 18:
        case 23:
        case 19:
        case 20:
          stems += n ~/ 2;
          if (stems > 96) _limit();
          if (op == 19 || op == 20) {
            cursor.at += (stems + 7) ~/ 8;
            if (cursor.at > b.length) _invalid();
          }
        case 4:
        case 21:
        case 22:
          final want = op == 21 ? 2 : 1;
          if (n == want + 1) {
            a = a.sublist(1);
            n--;
          }
          if (n != want) _invalid();
          if (op == 4) {
            move(0, a[0]);
          } else if (op == 22) {
            move(a[0], 0);
          } else {
            move(a[0], a[1]);
          }
        case 5:
          if (n < 2 || n.isOdd) _invalid();
          for (var j = 0; j < n; j += 2) line(a[j], a[j + 1]);
        case 6:
        case 7:
          var horizontal = op == 6;
          for (final v in a) {
            if (horizontal) {
              line(v, 0);
            } else {
              line(0, v);
            }
            horizontal = !horizontal;
          }
        case 8:
          if (n < 6 || n % 6 != 0) _invalid();
          for (var j = 0; j < n; j += 6) curve(a.sublist(j, j + 6));
        case 24:
          if (n < 8 || (n - 2) % 6 != 0) _invalid();
          for (var j = 0; j < n - 2; j += 6) curve(a.sublist(j, j + 6));
          line(a[n - 2], a[n - 1]);
        case 25:
          if (n < 8 || (n - 6) % 2 != 0) _invalid();
          for (var j = 0; j < n - 6; j += 2) line(a[j], a[j + 1]);
          curve(a.sublist(n - 6));
        case 26:
        case 27:
          if (n < 4 || n % 4 > 1) _invalid();
          var extra = 0.0;
          if (n % 4 == 1) {
            extra = a[0];
            a = a.sublist(1);
            n--;
          }
          for (var j = 0; j < n; j += 4) {
            if (op == 26) {
              curve([extra, a[j], a[j + 1], a[j + 2], 0, a[j + 3]]);
            } else {
              curve([a[j], extra, a[j + 1], a[j + 2], a[j + 3], 0]);
            }
            extra = 0;
          }
        case 30:
        case 31:
          if (n < 4 || n % 4 > 1) _invalid();
          var h = op == 31;
          for (var j = 0; j + 3 < n; j += 4) {
            final extra = j + 5 == n ? a[j + 4] : 0.0;
            if (h) {
              curve([a[j], 0, a[j + 1], a[j + 2], extra, a[j + 3]]);
            } else {
              curve([0, a[j], a[j + 1], a[j + 2], a[j + 3], extra]);
            }
            h = !h;
          }
        case 10:
        case 29:
          if (n < 1) _invalid();
          var idx = a[n - 1].truncate();
          stack = stack.sublist(0, n - 1);
          final sub = op == 29 ? font.global : local;
          if (!font.type1) idx += _subrBias(sub.length);
          if (idx < 0 || idx >= sub.length) _invalid();
          run(sub[idx], depth + 1);
          continue;
        case 11:
          return;
        case 14:
          if (n > 1) _unsupported('Composite endchar not supported');
          close();
          done = true;
        case 1234:
          if (n != 7) _invalid();
          curve([a[0], 0, a[1], a[2], a[3], 0]);
          curve([a[4], 0, a[5], -a[2], a[6], 0]);
        case 1235:
          if (n != 13) _invalid();
          curve(a.sublist(0, 6));
          curve(a.sublist(6, 12));
        case 1236:
          if (n != 9) _invalid();
          curve([a[0], a[1], a[2], a[3], a[4], 0]);
          curve([a[5], 0, a[6], a[7], a[8], -a[1] - a[3] - a[7]]);
        case 1237:
          if (n != 11) _invalid();
          var dx = 0.0, dy = 0.0;
          for (var j = 0; j < 10; j += 2) {
            dx += a[j];
            dy += a[j + 1];
          }
          var xx = -dx, yy = a[10];
          if (dx.abs() > dy.abs()) {
            xx = a[10];
            yy = -dy;
          }
          curve(a.sublist(0, 6));
          curve([a[6], a[7], a[8], a[9], xx, yy]);
        case 1212:
          if (n < 2 || a[n - 1] == 0) _invalid();
          stack[n - 2] /= a[n - 1];
          stack = stack.sublist(0, n - 1);
          continue;
        case 9:
          if (!font.type1) _invalid();
          close();
        case 13:
          if (!font.type1 || n != 2) _invalid();
          x = a[0];
          y = 0;
        case 1200:
        case 1201:
        case 1202:
          if (!font.type1) _invalid();
        case 1207:
          if (!font.type1 || n != 4) _invalid();
          x = a[0];
          y = a[1];
        case 1216:
          if (!font.type1 || n < 2) _invalid();
          final count = a[n - 2].truncate(), sub = a[n - 1].truncate();
          if (count < 0 || count > n - 2) _invalid();
          final args = a.sublist(n - 2 - count, n - 2);
          others = [];
          if (sub == 0) {
            if (count != 3 || flexPoints.length != 7 || !flex) _invalid();
            final v = flexPoints;
            point('C', [v[1].$1, v[1].$2, v[2].$1, v[2].$2, v[3].$1, v[3].$2]);
            point('C', [v[4].$1, v[4].$2, v[5].$1, v[5].$2, v[6].$1, v[6].$2]);
            flex = false;
            others = [args[1], args[2]];
          } else if (sub == 1) {
            if (count != 0) _invalid();
            flex = true;
            flexPoints = [];
          } else if (sub == 2) {
            if (count != 0 || !flex || flexPoints.length >= 7) _invalid();
            flexPoints.add((x, y));
          } else if (sub == 3) {
            if (count != 1) _invalid();
            others.add(args[0]);
          } else {
            _unsupported('Unsupported Type 1 OtherSubr $sub');
          }
          stack = stack.sublist(0, n - 2 - count);
          continue;
        case 1217:
          if (!font.type1 || others.isEmpty) _invalid();
          stack.add(others.removeAt(0));
          continue;
        case 1233:
          if (!font.type1 || n != 2) _invalid();
          x = a[0];
          y = a[1];
        default:
          _unsupported('Unsupported charstring operator $op');
      }
      stack = [];
    }
  }
}
