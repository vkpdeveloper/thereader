part of pdf_extractor;

void _type3Mask(_CharString c, _Lexer l, _Matrix ctm) {
  final d = <String, Object?>{};
  for (var n = 0; n < 32; n++) {
    final v = l.value();
    if (v is _Keyword && v.value == 'ID') break;
    if (v is! _Name) _invalid();
    d[v.value] = l.value();
    if (n == 31) _limit();
  }
  Object? get(String short, String long) => d[long] ?? d[short];
  final w = _integer(get('W', 'Width')), h = _integer(get('H', 'Height'));
  if (get('IM', 'ImageMask') != true || w < 1 || h < 1 || w > 65536 / h)
    _limit();
  final bpc = get('BPC', 'BitsPerComponent');
  if (bpc != null && _integer(bpc) != 1 || get('DP', 'DecodeParms') != null)
    _invalid();
  var paint = 0;
  final decode = _asArray(get('D', 'Decode'));
  if (decode.isNotEmpty) {
    if (decode.length != 2 || _number(decode[0]) + _number(decode[1]) != 1)
      _invalid();
    if (_number(decode[0]) == 1) {
      paint = 1;
    } else if (_number(decode[0]) != 0) {
      _invalid();
    }
  }
  if (l.pos >= l.data.length || !_white(l.data[l.pos])) _invalid();
  if (l.data[l.pos] == 13 && l.at(l.pos + 1) == 10) l.pos++;
  l.pos++;
  final stride = (w + 7) ~/ 8, length = stride * h;
  late Uint8List data;
  switch (_named(get('F', 'Filter'))) {
    case '':
      if (length > l.data.length - l.pos) _invalid();
      data = _slice(l.data, l.pos, l.pos + length);
      l.pos += length;
    case 'Fl':
    case 'FlateDecode':
      final result = _inflateMember(_slice(l.data, l.pos), length);
      data = result.$1;
      l.pos += result.$2;
    default:
      _invalid();
  }
  if (data.length != length || l.word() != 'EI') _invalid();
  bool pixel(int x, int y) =>
      ((data[y * stride + (x >> 3)] >> (7 - x % 8)) & 1) == paint;
  for (var y = 0; y < h; y++)
    for (var x = 0; x < w;) {
      if (!pixel(x, y)) {
        x++;
        continue;
      }
      final start = x;
      while (x < w && pixel(x, y)) x++;
      final coords = [
        (start / w, 1 - y / h),
        (x / w, 1 - y / h),
        (x / w, 1 - (y + 1) / h),
        (start / w, 1 - (y + 1) / h),
      ];
      for (var j = 0; j < coords.length; j++) {
        final (a, b) = _point(ctm, coords[j].$1, coords[j].$2);
        c.point(j == 0 ? 'M' : 'L', [a, b]);
      }
      c.path.write('Z');
    }
}

void _type3Outline(_CharString c, Uint8List b) {
  final l = _Lexer(b), stack = <_Matrix>[];
  var a = <double>[], ctm = _Matrix.from(_identity);
  void draw(String op, List<double> coords) {
    final transformed = <double>[];
    for (var j = 0; j + 1 < coords.length; j += 2) {
      final (x, y) = _point(ctm, coords[j], coords[j + 1]);
      transformed.addAll([x, y]);
    }
    c.point(op, transformed);
  }

  void need(int n) {
    if (a.length != n) _invalid();
  }

  while (l.pos < b.length) {
    l.skip();
    if (l.pos == b.length) break;
    final v = l.value();
    if (v is! _Keyword) {
      if (v is! num) _invalid();
      a.add(v.toDouble());
      if (a.length > 6) _limit();
      continue;
    }
    if (++c.ops > 100000) _limit();
    switch (v.value) {
      case 'd0':
      case 'd1':
        break;
      case 'q':
        if (stack.length >= 32) _limit();
        stack.add(ctm);
      case 'Q':
        if (stack.isEmpty) _invalid();
        ctm = stack.removeLast();
      case 'cm':
        need(6);
        ctm = _mul(ctm, a);
        _validMatrix(ctm);
      case 'BI':
        _type3Mask(c, l, ctm);
      case 'm':
      case 'l':
        need(2);
        if (v.value == 'm') {
          c.close();
          c.open = true;
          draw('M', a);
        } else {
          draw('L', a);
        }
        c.x = a[0];
        c.y = a[1];
      case 'c':
        need(6);
        draw('C', a);
        c.x = a[4];
        c.y = a[5];
      case 'v':
      case 'y':
        need(4);
        draw('C', v.value == 'v' ? [c.x, c.y, ...a] : [...a, a[2], a[3]]);
        c.x = a[2];
        c.y = a[3];
      case 'h':
      case 'f':
      case 'F':
        c.close();
      default:
        _invalid();
    }
    a = [];
  }
  c.close();
}
