part of pdf_extractor;

class _Graphics {
  _Matrix ctm, tm, tl;
  _Font? font;
  double size = 0,
      charSpace = 0,
      wordSpace = 0,
      scale = 1,
      leading = 0,
      rise = 0,
      lineWidth = 1;
  int mode = 0;
  String fill = '#000000', stroke = '#000000';
  _Graphics([this.ctm = _identity]) : tm = _identity, tl = _identity;
  _Graphics copy() => _Graphics(ctm)
    ..tm = tm
    ..tl = tl
    ..font = font
    ..size = size
    ..charSpace = charSpace
    ..wordSpace = wordSpace
    ..scale = scale
    ..leading = leading
    ..rise = rise
    ..lineWidth = lineWidth
    ..mode = mode
    ..fill = fill
    ..stroke = stroke;
}

class _Span {
  String text, link, role, script;
  Rect box;
  double size, baseline;
  bool bold, italic, mono;
  int mcid;
  _Font? font;
  Uint8List encoded;
  _Graphics graphics;
  _Span({
    required this.text,
    required this.box,
    required this.size,
    this.bold = false,
    this.italic = false,
    this.mono = false,
    this.link = '',
    this.role = '',
    this.mcid = -1,
    this.baseline = 0,
    this.script = '',
    this.font,
    Uint8List? encoded,
    _Graphics? graphics,
  }) : encoded = encoded ?? Uint8List(0),
       graphics = graphics ?? _Graphics();
  _Span copy() => _Span(
    text: text,
    box: box,
    size: size,
    bold: bold,
    italic: italic,
    mono: mono,
    link: link,
    role: role,
    mcid: mcid,
    baseline: baseline,
    script: script,
    font: font,
    encoded: encoded,
    graphics: graphics,
  );
}

class _Ruling {
  final double x1, y1, x2, y2;
  _Ruling(this.x1, this.y1, this.x2, this.y2);
}

class _VectorPath {
  final String svg;
  final Rect box;
  _VectorPath(this.svg, this.box);
}

class _PageContent {
  final Page page;
  List<_Span> spans = [];
  List<Block> images = [];
  List<_Ruling> rules = [];
  List<_VectorPath> paths = [];
  final _Ref? id;
  final Map<int, String> tags, alt;
  _PageContent(
    this.page, {
    this.id,
    Map<int, String>? tags,
    Map<int, String>? alt,
  }) : tags = tags ?? {},
       alt = alt ?? {};
}

class _Marked {
  String role, actual = '', alt = '';
  bool artifact;
  int start, mcid = -1;
  _Marked(this.role, this.artifact, this.start);
  _Marked copy() => _Marked(role, artifact, start)
    ..actual = actual
    ..alt = alt
    ..mcid = mcid;
}

abstract class _ImageReader {
  String image(_Stream s, int page);
  void inline(_Interpreter i, _Lexer l);
}

List<double>? _nums(List<Object?> a, int n) =>
    a.length == n && a.every((v) => v is num && v.abs() <= 1e8)
    ? a.map(_number).toList()
    : null;

class _Interpreter {
  final _PDF p;
  final _PageContent page;
  _Graphics g;
  _Dict resources;
  final _Fonts fonts;
  final _ImageReader images;
  final Set<_Stream> active;
  List<_Graphics> stack = [];
  List<_Marked> marks = [];
  String path = '';
  Rect? pathBox;
  double currentX = 0, currentY = 0, pathStartX = 0, pathStartY = 0;
  int depth = 0;
  _Interpreter(
    this.p,
    this.page,
    this.g,
    this.resources,
    this.fonts,
    this.images, [
    Set<_Stream>? active,
  ]) : active = active ?? {};
  _Marked? get marked => marks.isEmpty ? null : marks.last;
  void run(Uint8List data) {
    _validMatrix(g.ctm);
    final l = _Lexer(data);
    var args = <Object?>[];
    while (l.pos < data.length) {
      l.skip();
      if (l.pos == data.length) break;
      final v = l.value();
      if (v is! _Keyword) {
        args.add(v);
        if (args.length > 10000) _limit();
        continue;
      }
      if (++p.operations > p.limits.operations) _limit();
      if (p.operations % 1024 == 0) p.check();
      op(v.value, args, l);
      args = [];
    }
  }

  void op(String op, List<Object?> a, _Lexer l) {
    final g = this.g;
    switch (op) {
      case 'q':
        if (stack.length > 64) _limit();
        stack.add(g.copy());
      case 'Q':
        if (stack.isNotEmpty) this.g = stack.removeLast();
      case 'cm':
        final n = _nums(a, 6);
        if (n != null) {
          g.ctm = _mul(g.ctm, n);
          _validMatrix(g.ctm);
        }
      case 'BT':
        g.tm = _identity;
        g.tl = _identity;
      case 'ET':
        break;
      case 'Tf':
        if (a.length == 2) {
          g.font = fonts.get(
            p.dict(resources['Font'])[_named(a[0])],
            page.page.number,
          );
          g.size = _number(a[1]);
        }
      case 'Tm':
        final n = _nums(a, 6);
        if (n != null) {
          g.tm = n;
          g.tl = g.tm;
        }
      case 'Td':
      case 'TD':
        final n = _nums(a, 2);
        if (n != null) {
          if (op == 'TD') g.leading = -n[1];
          g.tl = _mul(g.tl, _translation(n[0], n[1]));
          g.tm = g.tl;
        }
      case 'T*':
        g.tl = _mul(g.tl, _translation(0, -g.leading));
        g.tm = g.tl;
      case 'Tc':
      case 'Tw':
      case 'Tz':
      case 'TL':
      case 'Ts':
      case 'Tr':
        if (a.length == 1) {
          final n = _number(a[0]);
          if (op == 'Tc') {
            g.charSpace = n;
          } else if (op == 'Tw') {
            g.wordSpace = n;
          } else if (op == 'Tz') {
            g.scale = n / 100;
          } else if (op == 'TL') {
            g.leading = n;
          } else if (op == 'Ts') {
            g.rise = n;
          } else {
            g.mode = n.truncate();
          }
        }
      case 'Tj':
        if (a.length == 1 && a[0] is _Literal) show((a[0] as _Literal).bytes);
      case "'":
      case '"':
        if (op == '"' && a.length == 3) {
          g.wordSpace = _number(a[0]);
          g.charSpace = _number(a[1]);
        }
        g.tl = _mul(g.tl, _translation(0, -g.leading));
        g.tm = g.tl;
        if (a.isNotEmpty && a.last is _Literal)
          show((a.last as _Literal).bytes);
      case 'TJ':
        if (a.length == 1)
          for (final v in _asArray(a[0])) {
            if (v is _Literal) {
              show(v.bytes);
            } else {
              g.tm = _mul(
                g.tm,
                _translation(-_number(v) * g.size * g.scale / 1000, 0),
              );
            }
          }
      case 'Do':
        if (a.length == 1) xobject(_named(a[0]));
      case 'BMC':
      case 'BDC':
        if (marks.length > 64) _limit();
        final m = _Marked(
          a.isEmpty ? '' : _named(a[0]),
          a.isNotEmpty && _named(a[0]) == 'Artifact' ||
              marked?.artifact == true,
          page.spans.length,
        );
        if (op == 'BDC' && a.length == 2) {
          var v = a[1];
          if (v is _Name) v = p.dict(resources['Properties'])[v.value];
          final d = p.dict(v);
          if (d.containsKey('MCID')) {
            m.mcid = _integer(d['MCID']);
            m.role = page.tags[m.mcid] ?? m.role;
            m.alt = page.alt[m.mcid] ?? '';
          }
          m.actual = _textString(d['ActualText']);
        }
        marks.add(m);
      case 'EMC':
        if (marks.isNotEmpty) {
          final m = marks.removeLast();
          if (m.actual.isNotEmpty && m.start < page.spans.length) {
            final s = page.spans[m.start].copy();
            for (final v in page.spans.skip(m.start + 1))
              s.box = _union(s.box, v.box);
            s.text = m.actual;
            page.spans.replaceRange(m.start, page.spans.length, [s]);
          }
        }
      case 'BI':
        images.inline(this, l);
      case 'gs':
        if (a.length == 1) {
          final d = p.dict(p.dict(resources['ExtGState'])[_named(a[0])]),
              f = p.array(d['Font']);
          if (f.length == 2) {
            g.font = fonts.get(f[0], page.page.number);
            g.size = _number(f[1]);
          }
          if (d['SMask'] != null && _named(d['SMask']) != 'None')
            p.warn(
              'transparency',
              page.page.number,
              'Graphics soft masks need visual review.',
            );
        }
      case 'w':
        if (a.length == 1) g.lineWidth = _number(a[0]);
      case 'g':
      case 'G':
        if (a.length == 1) {
          final n = _number(a[0]), c = _rgb(n, n, n);
          if (op == 'g') {
            g.fill = c;
          } else {
            g.stroke = c;
          }
        }
      case 'rg':
      case 'RG':
        final n = _nums(a, 3);
        if (n != null) {
          final c = _rgb(n[0], n[1], n[2]);
          if (op == 'rg') {
            g.fill = c;
          } else {
            g.stroke = c;
          }
        }
      case 'k':
      case 'K':
        final n = _nums(a, 4);
        if (n != null) {
          final c = _rgb(
            (1 - n[0]) * (1 - n[3]),
            (1 - n[1]) * (1 - n[3]),
            (1 - n[2]) * (1 - n[3]),
          );
          if (op == 'k') {
            g.fill = c;
          } else {
            g.stroke = c;
          }
        }
      case 'm':
      case 'l':
        final n = _nums(a, 2);
        if (n != null) {
          final (x, y) = _point(g.ctm, n[0], n[1]);
          if (op == 'l') {
            page.rules.add(_Ruling(currentX, currentY, x, y));
          } else {
            pathStartX = x;
            pathStartY = y;
          }
          pointPath(x, y);
          path += '${op.toUpperCase()}${_fnum(x)} ${_fnum(y)} ';
          currentX = x;
          currentY = y;
        }
      case 'c':
        final n = _nums(a, 6);
        if (n != null) {
          path += 'C';
          for (var j = 0; j < 6; j += 2) {
            final (x, y) = _point(g.ctm, n[j], n[j + 1]);
            pointPath(x, y);
            path += '${_fnum(x)} ${_fnum(y)} ';
            currentX = x;
            currentY = y;
          }
        }
      case 'v':
      case 'y':
        final n = _nums(a, 4);
        if (n != null) {
          final (x1, y1) = _point(g.ctm, n[0], n[1]);
          final (x2, y2) = _point(g.ctm, n[2], n[3]);
          final c = op == 'y' ? [x1, y1, x2, y2] : [currentX, currentY, x1, y1];
          path += 'C${[...c, x2, y2].map(_fnum).join(' ')} ';
          pointPath(x1, y1);
          pointPath(x2, y2);
          currentX = x2;
          currentY = y2;
        }
      case 're':
        final n = _nums(a, 4);
        if (n != null) {
          final pts = [
            (n[0], n[1]),
            (n[0] + n[2], n[1]),
            (n[0] + n[2], n[1] + n[3]),
            (n[0], n[1] + n[3]),
          ];
          var previous = (0.0, 0.0);
          for (var j = 0; j < pts.length; j++) {
            final (x, y) = _point(g.ctm, pts[j].$1, pts[j].$2);
            pointPath(x, y);
            if (j > 0) page.rules.add(_Ruling(previous.$1, previous.$2, x, y));
            path += '${j > 0 ? 'L' : 'M'}${_fnum(x)} ${_fnum(y)} ';
            previous = (x, y);
          }
          final (x, y) = _point(g.ctm, n[0], n[1]);
          page.rules.add(_Ruling(previous.$1, previous.$2, x, y));
          path += 'Z ';
        }
      case 'h':
        path += 'Z ';
        currentX = pathStartX;
        currentY = pathStartY;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paint(op);
      case 'n':
        path = '';
        pathBox = null;
      case 'W':
      case 'W*':
        final r = pathBox,
            full =
                r != null &&
                r.x.abs() < 1 &&
                r.y.abs() < 1 &&
                (r.width - page.page.width).abs() < 2 &&
                (r.height - page.page.height).abs() < 2;
        if (!full)
          p.warn(
            'clipping',
            page.page.number,
            'A clipping path is present; exported graphics may extend outside it.',
          );
      case 'sh':
        p.warn(
          'shading',
          page.page.number,
          'Gradient shading is not reconstructed.',
        );
      case 'CS':
      case 'cs':
      case 'SC':
      case 'SCN':
      case 'sc':
      case 'scn':
        p.warn(
          'color-space',
          page.page.number,
          'Custom graphics colors are approximated.',
        );
      case 'd':
      case 'J':
      case 'j':
      case 'M':
      case 'ri':
      case 'i':
      case 'BX':
      case 'EX':
      case 'MP':
      case 'DP':
        break;
      default:
        p.warn(
          'operator',
          page.page.number,
          'Unrecognized content operator: $op',
        );
    }
  }

  void show(Uint8List encoded) {
    final g = this.g;
    if (g.font == null) {
      g.font = fonts.get(null, page.page.number);
      p.warn(
        'missing-font',
        page.page.number,
        'Text without a font uses fallback positioning.',
      );
    }
    if (g.size == 0) return;
    var width = 0.0;
    final text = StringBuffer();
    for (var at = 0; at < encoded.length;) {
      final (u, code, n) = g.font!.glyph(_slice(encoded, at));
      width += (g.font!.width(code, u) * g.size / 1000 + g.charSpace) * g.scale;
      if (n == 1 && encoded[at] == 32) width += g.wordSpace * g.scale;
      text.write(u);
      at += n;
    }
    final transform = _mul(g.ctm, g.tm),
        saved = g.copy(),
        box = _rect(transform, 0, g.rise - g.size * .22, width, g.size);
    g.tm = _mul(g.tm, _translation(width, 0));
    if (text.isEmpty) return;
    final m = marked;
    if (m?.artifact == true && !p.options.keepArtifacts) return;
    final value = text.toString();
    if (value.contains('�'))
      p.warn(
        'unmapped-glyph',
        page.page.number,
        'Some glyphs could not be mapped to Unicode.',
      );
    _finiteRect(box);
    if (++p.spanCount > p.limits.spans) _limit();
    final size =
        g.size.abs() *
        math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
    if (size == 0) return;
    final baseline = _point(transform, 0, g.rise).$2;
    if (!p.options.keepArtifacts &&
        transform[1].abs() > transform[0].abs() * 2 &&
        (box.x + box.width < page.page.width * .08 ||
            box.x > page.page.width * .92))
      return;
    page.spans.add(
      _Span(
        text: value,
        box: box,
        size: size,
        bold: g.font!.bold,
        italic: g.font!.italic,
        mono: g.font!.mono,
        role: m?.role ?? '',
        mcid: m?.mcid ?? -1,
        baseline: baseline,
        font: g.font,
        encoded: encoded,
        graphics: saved,
      ),
    );
  }

  void xobject(String key) {
    final s = p.resolve(p.dict(resources['XObject'])[key]);
    if (s is! _Stream) return;
    if (_named(s.dict['Subtype']) == 'Image') {
      try {
        final asset = images.image(s, page.page.number),
            box = _rect(g.ctm, 0, 0, 1, 1);
        _finiteRect(box);
        page.images.add(
          Block(
            kind: 'image',
            asset: asset,
            alt: marked?.alt.isNotEmpty == true ? marked!.alt : 'Image',
            box: box,
          ),
        );
      } catch (e) {
        imageError(e);
      }
      return;
    }
    if (_named(s.dict['Subtype']) != 'Form') {
      p.warn('xobject', page.page.number, 'Unsupported XObject subtype');
      return;
    }
    if (depth >= 32 || active.contains(s)) _invalid('Recursive form XObject');
    final b = p.decode(s),
        child =
            _Interpreter(p, page, g.copy(), resources, fonts, images, active)
              ..depth = depth + 1
              ..marks = marks.map((m) => m.copy()).toList();
    final a = p.array(s.dict['Matrix']);
    if (a.length == 6) child.g.ctm = _mul(child.g.ctm, a.map(_number).toList());
    if (s.dict['Resources'] != null)
      child.resources = p.dict(s.dict['Resources']);
    active.add(s);
    try {
      child.run(b);
    } finally {
      active.remove(s);
    }
  }

  void imageError(Object e) {
    if (e is PdfException &&
        (e.code == 'RESOURCE_LIMIT' || e.code == 'ABORTED'))
      throw e;
    p.warn(
      'image',
      page.page.number,
      e is PdfException ? e.message : e.toString(),
    );
  }

  void pointPath(double x, double y) {
    final r = Rect(x, y, 0, 0);
    pathBox = pathBox == null ? r : _union(pathBox!, r);
  }

  void paint(String op) {
    if (marked?.artifact == true && !p.options.keepArtifacts) {
      path = '';
      pathBox = null;
      return;
    }
    final box = pathBox;
    if (box != null) {
      final fill = op == 'S' || op == 's' ? 'none' : g.fill,
          stroke = RegExp('[SsBb]').hasMatch(op) ? g.stroke : 'none',
          close = op == 's' || op.startsWith('b') ? ' Z' : '',
          rule = op.contains('*') ? 'evenodd' : 'nonzero',
          background =
              fill == '#ffffff' &&
              box.width >= page.page.width * .95 &&
              box.height >= page.page.height * .95;
      if (!background && (box.width > .05 || box.height > .05))
        page.paths.add(
          _VectorPath(
            '<path d="$path$close" fill="$fill" stroke="$stroke" stroke-width="${_fnum(g.lineWidth.abs())}" fill-rule="$rule"/>',
            box,
          ),
        );
    }
    path = '';
    pathBox = null;
  }
}

void _pageLinks(_PDF p, _PageContent pc, _Dict d, _Matrix base) {
  for (final v in p.array(d['Annots'])) {
    final a = p.dict(v);
    if (_named(a['Subtype']) != 'Link') {
      if (_named(a['Subtype']).isNotEmpty)
        p.warn(
          'annotation',
          pc.page.number,
          'Non-link annotation: ${_named(a['Subtype'])}',
        );
      continue;
    }
    final action = p.dict(a['A']), url = _textString(action['URI']);
    if (!_safeLink(url)) continue;
    final r = p.array(a['Rect']);
    if (r.length != 4) continue;
    final box = _rect(
      base,
      _number(r[0]),
      _number(r[1]),
      _number(r[2]) - _number(r[0]),
      _number(r[3]) - _number(r[1]),
    );
    for (final s in pc.spans) if (_intersects(s.box, box)) s.link = url;
  }
}

List<_Span> _deduplicateSpans(List<_Span> spans) {
  _stableSort(spans, (a, b) {
    final y = a.box.y.compareTo(b.box.y);
    return y != 0 ? y : a.box.x.compareTo(b.box.x);
  });
  final out = <_Span>[];
  for (final s in spans) {
    var duplicate = false;
    for (var j = out.length - 1; j >= 0 && j >= out.length - 12; j--) {
      final t = out[j];
      if ((t.box.y - s.box.y).abs() < 1 &&
          (t.box.x - s.box.x).abs() < 1 &&
          s.text == t.text) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.add(s);
  }
  return out;
}
