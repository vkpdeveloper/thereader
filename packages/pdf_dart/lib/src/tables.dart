part of pdf_extractor;

double _median(List<double> v) {
  v.sort();
  return v[v.length ~/ 2];
}

int _lowerBound(List<double> v, double n) {
  var lo = 0, hi = v.length;
  while (lo < hi) {
    final m = (lo + hi) ~/ 2;
    if (v[m] < n) {
      lo = m + 1;
    } else {
      hi = m;
    }
  }
  return lo;
}

(double, double) _tableBand(
  List<_Ruling> rules,
  Rect region,
  double y,
  double x,
) {
  var top = region.y, bottom = region.y + region.height;
  for (final r in rules) {
    if ((r.y1 - r.y2).abs() > 1 ||
        x < math.min(r.x1, r.x2) - 1 ||
        x > math.max(r.x1, r.x2) + 1)
      continue;
    if (r.y1 < y && r.y1 > top) top = r.y1;
    if (r.y1 > y && r.y1 < bottom) bottom = r.y1;
  }
  return (top, bottom);
}

void _removeRegion(_Line l, Rect region) {
  l.spans = l.spans
      .where(
        (s) =>
            s.box.x < region.x - 2 ||
            s.box.x + s.box.width > region.x + region.width + 2,
      )
      .toList();
  if (l.spans.isEmpty) {
    l.used = true;
  } else {
    l.box = l.spans.first.box;
    for (final s in l.spans.skip(1)) l.box = _union(l.box, s.box);
    _finishLine(l);
  }
}

List<_Line> _tableParts(_Line l, Rect region, List<_Ruling> rules) {
  final out = <_Line>[];
  _Line? part;
  for (final s in l.spans) {
    if (s.box.x < region.x - 2 ||
        s.box.x + s.box.width > region.x + region.width + 2)
      continue;
    var split = part == null;
    if (part != null) {
      final prev = part.spans.last;
      split = s.box.x - prev.box.x - prev.box.width > math.max(4, s.size * .75);
      for (final r in rules)
        if ((r.x1 - r.x2).abs() < 1 &&
            r.x1 > prev.box.x + prev.box.width &&
            r.x1 < s.box.x &&
            l.baseline >= math.min(r.y1, r.y2) &&
            l.baseline <= math.max(r.y1, r.y2)) {
          split = true;
          break;
        }
    }
    if (split) {
      part = _Line(s.box, l.baseline);
      out.add(part);
    } else {
      part!.box = _union(part.box, s.box);
    }
    part.spans.add(s);
  }
  for (final l in out) _finishLine(l);
  return out;
}

class _ExtraColumn {
  double left, right;
  int n = 1;
  _ExtraColumn(this.left, this.right);
}

Block? _buildRuledTable(
  List<_Line> lines,
  List<_Ruling> rules,
  Rect region,
  double body,
) {
  final rows = <({_Line line, List<_Line> parts})>[];
  var headerEnd = region.y;
  for (final r in rules)
    if ((r.y1 - r.y2).abs() < 1 &&
        r.y1 > region.y + body * .7 &&
        r.y1 < region.y + region.height - 1 &&
        math.min(r.x1, r.x2) <= region.x + 2 &&
        math.max(r.x1, r.x2) >= region.x + region.width - 2) {
      if (headerEnd == region.y || r.y1 < headerEnd) headerEnd = r.y1;
    }
  final freq = <int, int>{};
  for (final l in lines) {
    if (l.used ||
        l.baseline < region.y ||
        l.baseline > region.y + region.height + 1)
      continue;
    final parts = _tableParts(l, region, rules);
    if (parts.isEmpty) continue;
    rows.add((line: l, parts: parts));
    if (l.baseline > headerEnd && parts.length >= 2 && parts.length <= 64)
      freq[parts.length] = (freq[parts.length] ?? 0) + 1;
  }
  var columns = 0, count = 0;
  for (final e in freq.entries)
    if (e.value > count || e.value == count && e.key > columns) {
      columns = e.key;
      count = e.value;
    }
  if (columns < 2 || count < 2 || rows.length < 3) return null;
  if (columns <= 3 && rows.length >= 8) {
    var prose = 0, total = 0;
    for (final r in rows)
      for (final part in r.parts) {
        total++;
        if (part.text.trim().split(RegExp(r'\s+')).length >= 6 &&
            _byteLength(part.text) > 35)
          prose++;
      }
    var rowRules = 0;
    for (final r in rules)
      if ((r.y1 - r.y2).abs() < 1 &&
          r.y1 > region.y + body &&
          r.y1 < region.y + region.height - body &&
          math.min(r.x1, r.x2) <= region.x + 2 &&
          math.max(r.x1, r.x2) >= region.x + region.width - 2)
        rowRules++;
    if (prose * 2 > total && rowRules < 3) return null;
  }
  final left = <double>[], right = <double>[];
  for (var c = 0; c < columns; c++) {
    final a = <double>[], b = <double>[];
    for (final r in rows)
      if (r.line.baseline > headerEnd && r.parts.length == columns) {
        a.add(r.parts[c].box.x);
        b.add(r.parts[c].box.x + r.parts[c].box.width);
      }
    left.add(_median(a));
    right.add(_median(b));
  }
  final extras = <_ExtraColumn>[];
  for (final r in rows) {
    if (r.line.baseline <= headerEnd) continue;
    for (final part in r.parts) {
      final a = part.box.x, b = a + part.box.width;
      if (b >= left.first - body * .4 && a <= right.last + body * .4) continue;
      final e = extras
          .where(
            (e) =>
                (a - e.left).abs() < body * .5 ||
                ((a + b - e.left - e.right) / 2).abs() < body,
          )
          .firstOrNull;
      if (e == null) {
        extras.add(_ExtraColumn(a, b));
      } else {
        e.left = (e.left * e.n + a) / (e.n + 1);
        e.right = (e.right * e.n + b) / (e.n + 1);
        e.n++;
      }
    }
  }
  for (final e in extras)
    if (e.n >= 2) {
      left.add(e.left);
      right.add(e.right);
    }
  final cols = List.generate(
    left.length,
    (i) => (left: left[i], right: right[i]),
  );
  _stableSort(cols, (a, b) => a.left.compareTo(b.left));
  if (cols.length > 64) return null;
  final bound = [
    region.x,
    for (var i = 1; i < cols.length; i++)
      (cols[i - 1].right + cols[i].left) / 2,
    region.x + region.width,
  ];
  for (var c = 1; c < bound.length; c++)
    if (bound[c] <= bound[c - 1]) return null;
  int columnAt(Rect box) {
    var best = 0, overlap = -1.0;
    for (var c = 0; c < cols.length; c++) {
      final n = math.max(
        0.0,
        math.min(box.x + box.width, bound[c + 1]) - math.max(box.x, bound[c]),
      );
      if (n > overlap) {
        best = c;
        overlap = n;
      }
    }
    return best;
  }

  final headerCuts = <double>[];
  for (final r in rules)
    if ((r.y1 - r.y2).abs() < 1 &&
        r.y1 > region.y + 1 &&
        r.y1 < headerEnd - 1 &&
        (r.x2 - r.x1).abs() > body * 3)
      headerCuts.add(r.y1);
  headerCuts.sort();
  final cuts = <double>[];
  for (final y in headerCuts)
    if (cuts.isEmpty || y - cuts.last > 2) cuts.add(y);
  final headerBaselines = List.generate(cuts.length + 1, (_) => <double>[]);
  for (final r in rows)
    if (r.line.baseline < headerEnd)
      headerBaselines[_lowerBound(cuts, r.line.baseline)].add(r.line.baseline);
  final ys = headerBaselines.where((b) => b.isNotEmpty).map(_median).toList(),
      headerRows = ys.length;
  for (final r in rows)
    if (r.line.baseline >= headerEnd &&
        r.parts.length >= math.max(2, columns - 2))
      ys.add(r.line.baseline);
  if (ys.length - headerRows < 2) return null;
  for (final r in rows) {
    if (r.parts.length != 1 ||
        r.line.baseline < headerEnd ||
        _byteLength(r.parts.first.text) > 100)
      continue;
    final part = r.parts.first;
    if (part.box.x + part.box.width / 2 < region.x + region.width * .3)
      continue;
    final (top, bottom) = _tableBand(
      rules,
      region,
      r.line.baseline,
      region.x + region.width / 2,
    );
    if (!ys.any((y) => y > top && y < bottom) && bottom - top < body * 3)
      ys.add(r.line.baseline);
  }
  ys.sort();
  if (ys.length * cols.length > 100000) return null;
  final t = Table(
        rows: ys.length,
        columns: cols.length,
        headerRows: headerRows,
      ),
      partsByCell = <(int, int), List<_Span>>{},
      cellIndex = <(int, int), int>{};
  for (final r in rows)
    for (final part in r.parts) {
      var row = 0, dy = double.infinity;
      for (var j = 0; j < ys.length; j++) {
        final d = (ys[j] - r.line.baseline).abs();
        if (d < dy) {
          row = j;
          dy = d;
        }
      }
      var col = columnAt(part.box), cs = 1;
      if (row < headerRows) {
        for (final rule in rules) {
          final a = math.min(rule.x1, rule.x2), b = math.max(rule.x1, rule.x2);
          if ((rule.y1 - rule.y2).abs() > 1 ||
              rule.y1 <= r.line.baseline ||
              rule.y1 - r.line.baseline > body ||
              b - a >= region.width * .9 ||
              part.box.x < a - body ||
              part.box.x + part.box.width > b + body)
            continue;
          var first = -1, last = -1;
          for (var c = 0; c < cols.length; c++) {
            final center = (cols[c].left + cols[c].right) / 2;
            if (center >= a - 1 && center <= b + 1) {
              if (first < 0) first = c;
              last = c;
            }
          }
          if (first >= 0) {
            col = first;
            cs = last - first + 1;
            break;
          }
        }
      } else if (r.parts.length == 1 &&
          _byteLength(part.text) <= 100 &&
          part.box.x + part.box.width / 2 >= region.x + region.width * .3) {
        final (top, bottom) = _tableBand(
          rules,
          region,
          r.line.baseline,
          region.x + region.width / 2,
        );
        if (ys.where((y) => y > top && y < bottom).length == 1 &&
            bottom - top < body * 3) {
          col = 0;
          cs = cols.length;
        }
      }
      final k = (row, col), spans = partsByCell.putIfAbsent(k, () => []);
      for (final s in part.spans)
        spans.add(s.copy()..baseline = r.line.baseline);
      final at = cellIndex[k];
      if (at != null) {
        final c = t.cells[at];
        c.colSpan = math.max(c.colSpan, cs);
        c.box = _union(c.box, part.box);
      } else {
        cellIndex[k] = t.cells.length;
        t.cells.add(
          TableCell(row: row, column: col, colSpan: cs, box: part.box),
        );
      }
    }
  if (headerRows > 0 && cols.length > columns)
    for (final c in t.cells) {
      if (c.row != headerRows - 1 || c.column != 1 || c.colSpan != 1) continue;
      if (!t.cells.any((other) => other.row == c.row && other.column == 0) &&
          c.box.x < bound[1] &&
          c.box.x + c.box.width > bound[1]) {
        c.column = 0;
        c.colSpan = 2;
        partsByCell[(c.row, 0)] = partsByCell[(c.row, 1)]!;
      }
    }
  final byColumn = List.generate(cols.length, (_) => <int>[]);
  for (var j = 0; j < t.cells.length; j++) {
    final c = t.cells[j];
    if (c.row >= headerRows)
      for (
        var col = c.column;
        col < math.min(cols.length, c.column + c.colSpan);
        col++
      )
        byColumn[col].add(j);
  }
  for (var j = 0; j < t.cells.length; j++) {
    final c = t.cells[j], spans = partsByCell[(c.row, c.column)]!;
    c.runs = [];
    for (final l in _makeLines(spans)) {
      if (c.text.isNotEmpty) {
        c.text += ' ';
        c.runs.add(Run(text: ' '));
      }
      c.text += l.text;
      c.runs.addAll(l.runs);
    }
    if (c.row < headerRows) {
      c.header = true;
      c.scope = c.colSpan > 1 ? 'colgroup' : 'col';
      continue;
    }
    if (byColumn[c.column].length * 2 > ys.length - headerRows) continue;
    final baseline = _spanBaseline(spans.first);
    final (top, bottom) = _tableBand(
      rules,
      region,
      baseline,
      (cols[c.column].left + cols[c.column].right) / 2,
    );
    var first = -1, last = -1;
    for (var r = 0; r < ys.length; r++)
      if (r >= headerRows && ys[r] > top && ys[r] < bottom) {
        if (first < 0) first = r;
        last = r;
      }
    if (first < 0 ||
        last - first < 1 ||
        (baseline - (ys[first] + ys[last]) / 2).abs() >
            math.max(body, (bottom - top) * .12))
      continue;
    final occupied = byColumn[c.column].any((k) {
      final other = t.cells[k];
      return k != j &&
          other.row <= last &&
          other.row + other.rowSpan > first &&
          other.column <= c.column &&
          other.column + other.colSpan > c.column;
    });
    if (!occupied) {
      c.row = first;
      c.rowSpan = last - first + 1;
      if (c.column == 0) {
        c.header = true;
        c.scope = 'rowgroup';
      }
    }
  }
  final used = Uint8List(t.rows * t.columns);
  for (final c in t.cells)
    for (var r = c.row; r < c.row + c.rowSpan; r++)
      for (var col = c.column; col < c.column + c.colSpan; col++) {
        final at = r * t.columns + col;
        if (at < 0 || at >= used.length || col >= t.columns || used[at] != 0)
          return null;
        used[at] = 1;
      }
  final textRows = List.generate(t.rows, (_) => List.filled(t.columns, ''));
  for (var r = 0; r < t.rows; r++)
    for (var c = 0; c < t.columns; c++)
      if (used[r * t.columns + c] == 0)
        t.cells.add(
          TableCell(
            row: r,
            column: c,
            header: r < headerRows,
            box: const Rect(0, 0, 0, 0),
          ),
        );
  for (final c in t.cells) textRows[c.row][c.column] = c.text;
  _stableSort(
    t.cells,
    (a, b) =>
        a.row != b.row ? a.row.compareTo(b.row) : a.column.compareTo(b.column),
  );
  for (final r in rows) _removeRegion(r.line, region);
  return Block(kind: 'table', rows: textRows, table: t, box: region);
}

class _RuleGroup {
  final double x1, x2;
  final List<double> ys = [];
  _RuleGroup(this.x1, this.x2);
}

List<_RuleGroup> _ruleGroups(List<_Ruling> rules, double body) {
  final groups = <_RuleGroup>[];
  for (final r in rules) {
    final x1 = math.min(r.x1, r.x2), x2 = math.max(r.x1, r.x2);
    if ((r.y1 - r.y2).abs() > 1 || x2 - x1 < body * 10) continue;
    var g = groups
        .where((g) => (g.x1 - x1).abs() < 2 && (g.x2 - x2).abs() < 2)
        .firstOrNull;
    if (g == null) {
      g = _RuleGroup(x1, x2);
      groups.add(g);
    }
    g.ys.add(r.y1);
  }
  return groups;
}

List<Block> _legacyRuledTables(
  List<_Line> lines,
  List<_Ruling> rules,
  double body,
) {
  final out = <Block>[];
  for (final g in _ruleGroups(rules, body)) {
    g.ys.sort();
    for (var first = 0; first < g.ys.length;) {
      var end = first + 1;
      while (end < g.ys.length && g.ys[end] - g.ys[end - 1] < body * 14) end++;
      final top = g.ys[first], bottom = g.ys[end - 1];
      first = end;
      if (bottom - top < body * 1.8) continue;
      final region = Rect(g.x1, top, g.x2 - g.x1, bottom - top),
          rows = <_Line>[],
          sources = <_Line>[],
          freq = <int, int>{};
      for (final l in lines) {
        if (l.used || l.mono || l.baseline < top || l.baseline > bottom + 1)
          continue;
        final part = l.spans
            .where(
              (s) =>
                  s.box.x >= region.x - 2 &&
                  s.box.x + s.box.width <= region.x + region.width + 2,
            )
            .toList();
        if (part.isEmpty) continue;
        final row = _Line(part.first.box, l.baseline)..spans = part;
        for (final s in part.skip(1)) row.box = _union(row.box, s.box);
        _finishLine(row);
        rows.add(row);
        sources.add(l);
        if (row.cells.length >= 2 && row.cells.length <= 20)
          freq[row.cells.length] = (freq[row.cells.length] ?? 0) + 1;
      }
      var columns = 0, count = 0;
      for (final e in freq.entries)
        if (e.value > count || e.value == count && e.key > columns) {
          columns = e.key;
          count = e.value;
        }
      if (columns < 2 ||
          count < 2 ||
          rows.length < 2 ||
          count * 3 < rows.length)
        continue;
      final starts = List.generate(
            columns,
            (c) => _median(
              rows
                  .where((l) => l.cells.length == columns)
                  .map((l) => l.starts[c])
                  .toList(),
            ),
          ),
          boundaries = <double>[];
      for (var c = 0; c < columns - 1; c++) {
        var right = starts[c];
        for (final l in rows)
          if (l.cells.length == columns)
            for (final s in l.spans)
              if (s.box.x >= l.starts[c] - 1 && s.box.x < l.starts[c + 1] - 1)
                right = math.max(
                  right,
                  math.min(s.box.x + s.box.width, starts[c + 1] - 1),
                );
        boundaries.add(right + (starts[c + 1] - right) * .25);
      }
      final cells = <List<String>>[];
      for (var j = 0; j < rows.length; j++) {
        final l = rows[j];
        if (l.cells.length == 1 && _byteLength(l.text) > 100) continue;
        final row = List.filled(columns, ''),
            last = List<_Span?>.filled(columns, null);
        for (final s in l.spans) {
          final c = _lowerBound(
                boundaries,
                s.box.x + math.min(s.box.width * .3, 2),
              ),
              t = _deLigature(s.text),
              prev = last[c];
          if (prev != null &&
              s.box.x - prev.box.x - prev.box.width >
                  math.max(1, s.size * .15) &&
              !row[c].endsWith(' ') &&
              !t.startsWith(' '))
            row[c] += ' ';
          row[c] += t;
          last[c] = s;
        }
        cells.add(row.map((t) => t.trim()).toList());
        _removeRegion(sources[j], region);
      }
      out.add(Block(kind: 'table', rows: cells, box: region));
    }
  }
  return out;
}

List<Block> _ruledTables(List<_Line> lines, List<_Ruling> rules, double body) {
  final regions = <Rect>[];
  for (final g in _ruleGroups(rules, body)) {
    g.ys.sort();
    var start = 0;
    for (var end = 1; end <= g.ys.length; end++) {
      var separate = end == g.ys.length;
      if (!separate) {
        var prose = 0;
        for (final l in lines) {
          if (l.used || l.baseline <= g.ys[end - 1] || l.baseline >= g.ys[end])
            continue;
          if (RegExp(
            r'^(table|figure) ',
            caseSensitive: false,
          ).hasMatch(l.text)) {
            separate = true;
            break;
          }
          if (_byteLength(l.text) > 100 &&
              l.cells.length == 1 &&
              l.box.width > (g.x2 - g.x1) * .8)
            prose++;
        }
        separate = separate || prose >= 2;
      }
      if (separate) {
        if (end - start >= 2 && g.ys[end - 1] - g.ys[start] > body * 1.8)
          regions.add(
            Rect(g.x1, g.ys[start], g.x2 - g.x1, g.ys[end - 1] - g.ys[start]),
          );
        start = end;
      }
    }
  }
  _stableSort(
    regions,
    (a, b) => (b.width * b.height).compareTo(a.width * a.height),
  );
  final out = <Block>[];
  for (final region in regions) {
    final b = _buildRuledTable(lines, rules, region, body);
    if (b != null) out.add(b);
  }
  out.addAll(_legacyRuledTables(lines, rules, body));
  _stableSort(out, (a, b) => a.box.y.compareTo(b.box.y));
  return out;
}

List<Block> _detectTables(List<_Line> lines, List<_Ruling> rules, double body) {
  final out = _ruledTables(lines, rules, body);
  for (var i = 0; i < lines.length;) {
    final l = lines[i], columns = l.cells.length;
    if (l.used || columns < 2 || columns > 20 || l.mono || l.math) {
      i++;
      continue;
    }
    var end = i + 1;
    while (end < lines.length) {
      final next = lines[end], prev = lines[end - 1];
      if (next.used ||
          next.math ||
          next.cells.length != columns ||
          next.box.y - prev.box.y > body * 3 ||
          next.box.y - prev.box.y < 0 ||
          next.starts.indexed.any(
            (e) => (e.$2 - l.starts[e.$1]).abs() > body * 2,
          ))
        break;
      end++;
    }
    var box = l.box, long = false;
    final rows = <List<String>>[];
    for (var j = i; j < end; j++) {
      box = _union(box, lines[j].box);
      rows.add(lines[j].cells);
      if (lines[j].cells.any((c) => _byteLength(c) > 100)) long = true;
    }
    final ruled = rules.any(
          (r) =>
              (r.y1 - r.y2).abs() < 1 &&
              r.y1 >= box.y - body * 2 &&
              r.y1 <= box.y + box.height + body &&
              (r.x2 - r.x1).abs() >= box.width * .65,
        ),
        tagged = l.role == 'TH' || l.role == 'TD';
    if (end - i >= 2 &&
        !long &&
        (ruled || tagged || end - i >= 3 && (columns >= 3 || l.bold))) {
      for (var j = i; j < end; j++) lines[j].used = true;
      out.add(Block(kind: 'table', rows: rows, box: box));
      i = end;
    } else {
      i++;
    }
  }
  return out;
}
