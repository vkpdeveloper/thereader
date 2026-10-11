part of pdf_extractor;

final _prosePattern = RegExp(r'[A-Za-z]{3,}');

String _xmlText(String s) {
  final b = StringBuffer();
  for (final r in s.runes) {
    if (!(r == 9 ||
        r == 10 ||
        r == 13 ||
        r >= 32 && r <= 0xd7ff ||
        r >= 0xe000 && r <= 0xfffd ||
        r >= 0x10000 && r <= 0x10ffff))
      continue;
    b.write(
      const {
            38: '&amp;',
            60: '&lt;',
            62: '&gt;',
            34: '&#34;',
            39: '&#39;',
          }[r] ??
          String.fromCharCode(r),
    );
  }
  return b.toString();
}

String _general(double n) {
  if (n == 0) return n.isNegative ? '-0' : '0';
  final parts = n.toStringAsPrecision(12).split('e');
  var a = parts[0];
  if (a.contains('.')) {
    var end = a.length;
    while (end > 0 && a.codeUnitAt(end - 1) == 48) end--;
    if (end > 0 && a.codeUnitAt(end - 1) == 46) end--;
    a = a.substring(0, end);
  }
  if (parts.length == 1) return a;
  final e = int.parse(parts[1]);
  return '${a}e${e < 0 ? '-' : '+'}${e.abs().toString().padLeft(2, '0')}';
}

String _matrixSVG(_Matrix m) => 'matrix(${m.map(_general).join(' ')})';
final _mathWords =
    'sin cos tan cot sec csc log ln exp lim max min sup inf dim null range span rank det mod for and etc'
        .split(' ')
        .toSet();
List<String> _proseWords(String s) =>
    _prosePattern.allMatches(s).map((m) => m[0]!).toList();
final _operators = RegExp('[=+−×÷∑∫√≤≥∈→]');
bool _monochromeMath(List<_Span> spans, List<_VectorPath> paths) =>
    spans.every((s) => ['#000000', '#ffffff'].contains(s.graphics.fill)) &&
    paths.every(
      (p) => RegExp(
        r'#[0-9a-fA-F]{6}',
      ).allMatches(p.svg).every((m) => m[0] == '#000000' || m[0] == '#ffffff'),
    );
bool _mathLine(_Line l) {
  if (!l.math || l.mono) return l.role == 'Formula';
  if ([
    'of ',
    'and ',
    'where ',
    'for ',
    'with ',
    'suppose ',
    'let ',
    'then ',
    'if ',
    'proof ',
    'thus ',
    'hence ',
  ].any((w) => l.text.toLowerCase().startsWith(w)))
    return false;
  var m = 0, total = 0;
  for (final s in l.spans) {
    final n = _runeCount(s.text.trim());
    total += n;
    if (s.font?.math == true) m += n;
  }
  return total > 0 &&
      _proseWords(l.text).every((w) => _mathWords.contains(w.toLowerCase())) &&
      (m * 2 >= total || _operators.hasMatch(l.text));
}

bool _mathFragment(String text, bool mono) =>
    !mono &&
    _byteLength(text) <= 180 &&
    _proseWords(text).every((w) => _mathWords.contains(w.toLowerCase())) &&
    ![
      'of ',
      'and ',
      'for ',
      'if ',
    ].any((w) => text.toLowerCase().startsWith(w));
bool _annotationContinuation(_Line previous, _Line next) {
  final text = previous.text.trim(), first = next.text.trim().runes.firstOrNull;
  return text.isNotEmpty &&
      !RegExp(r'[.!?;:]$').hasMatch(text) &&
      !next.mono &&
      next.size <= previous.size * 1.1 &&
      first != null &&
      RegExp(r'\p{Ll}', unicode: true).hasMatch(String.fromCharCode(first)) &&
      _proseWords(next.text).isNotEmpty;
}

class _PositionedGraphics {
  final _PDF p;
  final _FontPrograms programs;
  final _Assets assets;
  _PositionedGraphics(this.p, this.programs, this.assets);
  (String, Rect) positionedAsset(
    _PageContent pc,
    List<_Span> spans,
    List<_VectorPath> paths,
    Rect box,
    String label,
  ) {
    final defs = StringBuffer(), body = StringBuffer();
    var count = 0, bodyBytes = 0;
    final ids = <_Font, Map<int, String>>{};
    void appendBody(String s) {
      body.write(s);
      bodyBytes += _byteLength(s);
    }

    void budget() {
      if (defs.length + bodyBytes + p.assetBytes + p.outlineBytes >
          p.limits.assetBytes)
        _limit();
    }

    for (final v in paths) {
      appendBody(v.svg);
      box = _union(box, v.box);
      budget();
    }
    for (final s in spans) {
      if (s.font == null || s.encoded.isEmpty) continue;
      final f = s.font!,
          g = s.graphics,
          transform = _mul(g.ctm, g.tm),
          program = programs.get(f, pc.page.number);
      var offset = 0.0;
      for (var at = 0; at < s.encoded.length;) {
        p.check();
        final raw = _slice(s.encoded, at);
        final (u, code, n) = f.glyph(raw);
        var advance =
            (f.width(code, u) * g.size / 1000 + g.charSpace) * g.scale;
        if (n == 1 && raw[0] == 32) advance += g.wordSpace * g.scale;
        final placed = _mul(transform, _translation(offset, g.rise));
        var painted = false;
        if (program != null) {
          final name = code < 256 ? f.names[code] : '',
              previous = program.cache.length;
          Object? error;
          _GlyphOutline? result;
          try {
            result = program.outline(code, name);
          } catch (e) {
            error = e;
          }
          final gid = program.names != null
                  ? program.names![name]
                  : program.codes[code],
              cached = gid == null ? null : program.cache[gid];
          if (program.cache.length > previous && cached != null) {
            p.operations += cached.operations;
            p.outlineBytes += _byteLength(cached.path);
          }
          if (p.operations > p.limits.operations) _limit();
          budget();
          if (result != null) {
            final placedGlyph = _mul(
                  _mul(placed, [g.size * g.scale, 0, 0, g.size, 0, 0]),
                  program.matrix,
                ),
                map = ids.putIfAbsent(f, () => {});
            var id = map[code];
            if (id == null) {
              id = 'g${count++}';
              map[code] = id;
              defs.write('<path id="$id" d="${result.path}"/>');
            }
            appendBody(
              '<use href="#$id" transform="${_matrixSVG(placedGlyph)}" fill="${g.fill}"/>',
            );
            final r = result.box;
            if (r != null) {
              final drawn = _rect(placedGlyph, r.x, r.y, r.width, r.height);
              _finiteRect(drawn);
              box = _union(box, drawn);
            }
            painted = true;
          } else {
            if (error is PdfException &&
                (error.code == 'RESOURCE_LIMIT' || error.code == 'ABORTED'))
              throw error;
            p.warn(
              'glyph-outline',
              pc.page.number,
              'Some positioned glyphs use Unicode fallback: ${error is PdfException ? error.message : error}',
            );
          }
        }
        if (!painted) {
          final family = f.mono ? 'monospace' : 'serif',
              style =
                  (f.bold ? ' font-weight="bold"' : '') +
                  (f.italic ? ' font-style="italic"' : ''),
              m = _mul(placed, [g.scale, 0, 0, -1, 0, 0]);
          appendBody(
            '<text transform="${_matrixSVG(m)}" font-family="$family" font-size="${_fnum(g.size.abs())}" fill="${g.fill}"$style>${_xmlText(u)}</text>',
          );
        }
        offset += advance;
        at += n;
        budget();
      }
    }
    box = _expand(box, 1);
    final svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="${_fnum(box.x)} ${_fnum(box.y)} ${_fnum(box.width)} ${_fnum(box.height)}" width="${_fnum(box.width)}" height="${_fnum(box.height)}" role="img"><title>${_xmlText(label)}</title><rect x="${_fnum(box.x)}" y="${_fnum(box.y)}" width="${_fnum(box.width)}" height="${_fnum(box.height)}" fill="white"/><defs>$defs</defs>$body</svg>';
    return (
      assets.add(
        Uint8List.fromList(utf8.encode(svg)),
        'image/svg+xml',
        'svg',
        box.width.ceil(),
        box.height.ceil(),
      ),
      box,
    );
  }

  List<Block> mathBlocks(_PageContent pc, List<_Line> lines) {
    final blocks = <Block>[];
    for (var j = 0; j < lines.length; j++) {
      final l = lines[j];
      if (l.used || !_mathLine(l)) continue;
      l.used = true;
      final group = [...l.spans];
      var box = l.box, text = l.text;
      for (var k = j + 1; k < lines.length; k++) {
        final next = lines[k];
        if (next.box.y > box.y + box.height + math.max(l.size, 10) * 1.6) break;
        if (next.used ||
            !_mathFragment(next.text, next.mono) ||
            next.box.x > box.x + box.width + l.size ||
            box.x > next.box.x + next.box.width + l.size)
          continue;
        next.used = true;
        group.addAll(next.spans);
        box = _union(box, next.box);
        text += ' ${next.text}';
      }
      for (var k = 0; k < lines.length; k++) {
        final candidate = lines[k];
        if (candidate.used ||
            !candidate.math ||
            candidate.baseline < box.y ||
            candidate.baseline > box.y + box.height ||
            candidate.box.x > box.x + box.width + l.size * 2 ||
            candidate.box.x + candidate.box.width < box.x - l.size * 2)
          continue;
        final words = _proseWords(
          candidate.text,
        ).where((w) => !_mathWords.contains(w.toLowerCase())).toList();
        if (words.isEmpty ||
            words.join('').length > 28 ||
            !_operators.hasMatch(candidate.text))
          continue;
        var mathCount = 0, annotationX = double.infinity;
        for (final s in candidate.spans) {
          if (s.font?.math == true) mathCount += _runeCount(s.text);
          if (_proseWords(
            s.text,
          ).any((w) => !_mathWords.contains(w.toLowerCase())))
            annotationX = math.min(annotationX, s.box.x);
        }
        if (mathCount < 3) continue;
        candidate.used = true;
        group.addAll(candidate.spans);
        box = _union(box, candidate.box);
        text += ' ${candidate.text}';
        if (k + 1 < lines.length && annotationX > box.x + box.width * .45) {
          var n = k + 1;
          while (n < lines.length && lines[n].used) n++;
          if (n == lines.length) continue;
          final next = lines[n];
          if (!next.used &&
              _annotationContinuation(candidate, next) &&
              (next.box.x - annotationX).abs() <= l.size &&
              next.box.x + next.box.width <= box.x + box.width + l.size &&
              next.baseline > candidate.baseline &&
              next.baseline - candidate.baseline < l.size * 2 &&
              _byteLength(next.text) < 70) {
            next.used = true;
            group.addAll(next.spans);
            box = _union(box, next.box);
            text += ' ${next.text}';
          }
        }
      }
      for (final candidate in lines) {
        if (candidate.used ||
            !_intersects(
              candidate.box,
              _expand(box, math.max(l.size, 10) * .4),
            ))
          continue;
        final kept = <_Span>[];
        for (final s in candidate.spans) {
          if (_contained(s.box, box, math.max(l.size, 10) * .4) &&
              _mathFragment(s.text, s.mono)) {
            group.add(s);
            box = _union(box, s.box);
            text += ' ${s.text}';
          } else {
            kept.add(s);
          }
        }
        if (kept.length == candidate.spans.length) continue;
        candidate.spans = kept;
        if (kept.isEmpty) {
          candidate.used = true;
        } else {
          candidate.box = kept
              .skip(1)
              .fold(kept.first.box, (b, s) => _union(b, s.box));
          _finishLine(candidate);
        }
      }
      final paths = pc.paths
          .where((path) => _contained(path.box, box, l.size * .4))
          .toList();
      final (asset, visualBox) = positionedAsset(pc, group, paths, box, text);
      blocks.add(
        Block(
          kind: 'math',
          text: text,
          asset: asset,
          alt: text,
          box: visualBox,
          representation: 'positioned',
          role: 'formula',
          widthEm: visualBox.width / l.size,
          monochrome: _monochromeMath(group, paths),
        ),
      );
    }
    if (blocks.isNotEmpty)
      p.warn(
        'math-positioned',
        0,
        'Equations preserve PDF glyph positions and paths. Their linear text is not semantic LaTeX or MathML.',
      );
    return blocks;
  }

  void inlineMath(_PageContent pc, _Line l) {
    final runs = <Run>[];
    for (var j = 0; j < l.spans.length;) {
      final s = l.spans[j];
      var end = j + 1;
      if (s.font?.math == true)
        while (end < l.spans.length) {
          final n = l.spans[end], prev = l.spans[end - 1];
          if (n.font?.math != true ||
              n.box.x - prev.box.x - prev.box.width > l.size * .8)
            break;
          end++;
        }
      var unmapped = false, visual = false, box = s.box;
      for (var k = j; k < end; k++) {
        final v = l.spans[k];
        unmapped = unmapped || v.font != null && v.text.contains('�');
        box = _union(box, v.box);
        visual = visual || v.script.isNotEmpty || v.size > l.size * 1.35;
      }
      visual = visual || unmapped;
      var prefix = '';
      if (j > 0) {
        final prev = l.spans[j - 1];
        if (s.box.x - prev.box.x - prev.box.width > math.max(1, l.size * .15) &&
            !prev.text.endsWith(' ') &&
            !s.text.startsWith(' '))
          prefix = ' ';
      }
      if (visual && s.font != null && (s.font!.math || unmapped)) {
        final group = l.spans.sublist(j, end),
            text = group.map((v) => _deLigature(v.text)).join();
        final (asset, box2) = positionedAsset(pc, group, [], box, text);
        if (prefix.isNotEmpty) runs.add(Run(text: prefix));
        runs.add(
          Run(
            text: text,
            asset: asset,
            heightEm: box2.height / l.size,
            depthEm: math.max(0, (box2.y + box2.height - l.baseline) / l.size),
            monochrome: _monochromeMath(group, []),
          ),
        );
      } else {
        for (var k = j; k < end; k++) {
          final v = l.spans[k];
          runs.add(
            Run(
              text: (k == j ? prefix : '') + _deLigature(v.text),
              bold: v.bold,
              italic: v.italic,
              link: v.link,
              script: v.script,
            ),
          );
        }
      }
      j = end;
    }
    l.runs = runs;
  }

  void vectorAsset(
    _PageContent pc,
    List<Block> represented,
    List<_Line> lines,
  ) {
    if (pc.paths.length > 5000) {
      p.warn(
        'vector-complexity',
        pc.page.number,
        'More than 5000 paths on a page; vector grouping skipped.',
      );
      return;
    }
    final groups = <_PathGroup>[];
    for (final path in pc.paths) {
      if (represented.any((b) => _contained(path.box, b.box, 2)) ||
          path.box.width < .1 ||
          path.box.height < .1)
        continue;
      final c = _PathGroup(path.box, [path]);
      for (var j = 0; j < groups.length;) {
        if (_intersects(_expand(c.box, 2), groups[j].box)) {
          c.box = _union(c.box, groups[j].box);
          c.paths.addAll(groups[j].paths);
          groups.removeAt(j);
          j = 0;
        } else {
          j++;
        }
      }
      groups.add(c);
    }
    for (final group in groups) {
      final box = group.box;
      if (box.width < 12 || box.height < 12) continue;
      final labels = <_Span>[], texts = <String>[];
      var chars = 0;
      for (final l in lines)
        if (!l.used)
          for (final s in l.spans)
            if (_contained(s.box, box, 2)) {
              labels.add(s);
              texts.add(s.text);
              chars += _byteLength(s.text);
            }
      if (group.paths.length < 8 && chars > 50) continue;
      if (group.paths.length == 1 &&
          chars == 0 &&
          'C'.allMatches(group.paths.first.svg).length < 5)
        continue;
      for (final l in lines) {
        if (l.used) continue;
        final kept = l.spans.where((s) => !_contained(s.box, box, 2)).toList();
        if (kept.length == l.spans.length) continue;
        l.spans = kept;
        if (kept.isEmpty) {
          l.used = true;
        } else {
          l.box = kept.skip(1).fold(kept.first.box, (b, s) => _union(b, s.box));
          _finishLine(l);
        }
      }
      final text = texts.join(' ');
      final (asset, visualBox) = positionedAsset(
        pc,
        labels,
        group.paths,
        box,
        text,
      );
      pc.images.add(
        Block(
          kind: 'image',
          asset: asset,
          alt: 'Vector illustration',
          text: text,
          box: visualBox,
          representation: 'positioned',
        ),
      );
    }
  }
}

class _PathGroup {
  Rect box;
  final List<_VectorPath> paths;
  _PathGroup(this.box, this.paths);
}
