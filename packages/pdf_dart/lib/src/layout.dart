part of pdf_extractor;

final _step = RegExp(r'^(\d{1,4}):\s*');
List<Block> _algorithmBlocks(
  List<_Line> lines,
  List<_Ruling> rules,
  double body,
) {
  final out = <Block>[];
  for (var start = 0; start < lines.length; start++) {
    final title = lines[start];
    if (title.used ||
        !RegExp(
          r'^Algorithm\s+\d+[.:\s]',
          caseSensitive: false,
        ).hasMatch(title.text))
      continue;
    final ends =
        rules
            .where(
              (r) =>
                  (r.y1 - r.y2).abs() < 1 &&
                  r.y1 > title.baseline + body * 4 &&
                  math.min(r.x1, r.x2) <= title.box.x + body &&
                  (r.x2 - r.x1).abs() >= title.box.width,
            )
            .map((r) => r.y1)
            .toList()
          ..sort();
    for (final bottom in ends) {
      final selected = <_Line>[];
      var last = 0, numbered = 0, valid = true;
      for (final l in lines.skip(start + 1)) {
        if (l.baseline > bottom) break;
        if (l.used) {
          valid = false;
          break;
        }
        final m = _step.firstMatch(l.text);
        if (m != null) {
          final n = int.parse(m[1]!);
          if (n != last + 1) {
            valid = false;
            break;
          }
          last = n;
          numbered++;
        }
        selected.add(l);
      }
      if (!valid || numbered < 3) continue;
      final code = Block(
        kind: 'code',
        language: 'pseudocode',
        role: 'algorithm',
        box: selected.first.box,
      );
      var baseX = double.infinity;
      double contentX(_Line l) {
        final m = _step.firstMatch(l.text)?[0];
        if (m == null) return l.box.x;
        var n = 0;
        for (final s in l.spans) {
          n += _byteLength(s.text);
          if (n >= _byteLength(m.trim())) {
            if (n == _byteLength(m.trim())) continue;
            return s.box.x;
          }
        }
        return l.box.x;
      }

      for (final l in selected)
        if (_step.hasMatch(l.text)) baseX = math.min(baseX, contentX(l));
      for (var j = 0; j < selected.length; j++) {
        final l = selected[j];
        var text = l.text;
        final m = _step.firstMatch(text)?[0];
        if (m != null) {
          final indent = math.min(
            40,
            (math.max(0, contentX(l) - baseX) / math.max(1, l.size * .75) + .5)
                .floor(),
          );
          text = '${m.trim()} ${' ' * indent}${text.substring(m.length)}';
        }
        if (j > 0) {
          code.text += '\n';
          code.box = _union(code.box, l.box);
        }
        code.text += text;
        l.used = true;
      }
      title.used = true;
      out.addAll([
        Block(
          kind: 'paragraph',
          text: title.text,
          runs: title.runs,
          role: 'caption',
          box: title.box,
        ),
        code,
      ]);
      break;
    }
  }
  return out;
}

List<Block> _layout(
  _PageContent pc,
  double body,
  _PositionedGraphics graphics,
) {
  final lines = _makeLines(pc.spans),
      algorithms = _algorithmBlocks(lines, pc.rules, body),
      formulas = graphics.mathBlocks(pc, lines);
  graphics.vectorAsset(pc, formulas, lines);
  final tables = _detectTables(lines, pc.rules, body),
      ordered = _columnOrder(
        lines.where((l) => !l.used).toList(),
        pc.page.width,
      ),
      words = _pageWords(ordered);
  for (final l in ordered)
    if (l.math || l.text.contains('�')) graphics.inlineMath(pc, l);
  final blocks = <Block>[];
  Block? current;
  _Line? previous;
  void flush() {
    final c = current;
    if (c != null) {
      c.text = c.kind == 'code'
          ? c.text.replaceFirst(RegExp(r'[ \t\r\n]+$'), '')
          : c.text.trim();
      if (c.kind == 'code') c.language = _codeLanguage(c.text);
      blocks.add(c);
      current = null;
    }
  }

  for (final l in ordered) {
    if (l.text.isEmpty) continue;
    final (kind, level, role) = _classifyLine(l, body);
    final gap = previous != null
        ? l.box.y - previous.box.y - previous.box.height
        : 0;
    var join =
        current != null &&
        current!.kind == kind &&
        kind != 'heading' &&
        kind != 'list' &&
        current!.role == role &&
        previous != null &&
        gap >= -2 &&
        gap < math.max(l.size * .8, 4) &&
        (l.box.x - previous.box.x).abs() < math.max(l.size * 2, 24);
    if (kind == 'heading' && current != null && previous != null)
      join =
          current!.kind == 'heading' &&
          current!.level == level &&
          gap >= -2 &&
          gap < l.size * .8 &&
          ((l.box.x - previous.box.x).abs() < l.size ||
              (l.box.x +
                          l.box.width / 2 -
                          previous.box.x -
                          previous.box.width / 2)
                      .abs() <
                  l.size * 2);
    if (kind == 'code')
      join =
          current != null &&
          current!.kind == 'code' &&
          gap >= -2 &&
          gap < l.size * 3;
    if (join && current != null && previous != null) {
      final c = current!;
      var separator = ' ';
      if (kind == 'code') {
        separator = gap > l.size * .9 ? '\n\n' : '\n';
        final indent =
            (math.max(0, l.box.x - c.box.x) / math.max(1, l.size * .6) + .5)
                .floor();
        separator += ' ' * math.min(indent, 80);
      } else if (kind == 'paragraph' &&
          !previous.math &&
          !l.math &&
          _witnessedHyphen(c.text, l.text, words)) {
        c.text = c.text.replaceFirst(RegExp(r'-$'), '');
        for (var j = c.runs.length - 1; j >= 0; j--)
          if (c.runs[j].text.isNotEmpty) {
            c.runs[j].text = c.runs[j].text.replaceFirst(RegExp(r'-$'), '');
            break;
          }
        separator = '';
      } else if (_canDehyphenate(c.text, l.text) || _endsSoftHyphen(previous)) {
        separator = '';
      }
      c.text += separator + l.text;
      if (l.runs.isNotEmpty) {
        final runs = l.runs.map((r) => r.copy()).toList();
        runs.first.text =
            separator + runs.first.text.replaceFirst(RegExp(r'^ +'), '');
        c.runs.addAll(runs);
      }
      c.box = _union(c.box, l.box);
    } else {
      flush();
      current = Block(
        kind: kind,
        text: l.text,
        runs: l.runs,
        level: level,
        role: role,
        box: l.box,
      );
    }
    previous = l;
  }
  flush();
  for (final b in [...algorithms, ...formulas, ...tables, ...pc.images]) {
    var at = blocks.indexWhere((t) => t.box.y > b.box.y + b.box.height * .25);
    if (at < 0) at = blocks.length;
    blocks.insert(at, b);
  }
  return blocks;
}
