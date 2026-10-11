part of pdf_extractor;

final _ligaturePattern = RegExp('[ﬁﬂﬀﬃﬄ\u00ad\u00a0]');

void _stableSort<T>(List<T> list, int Function(T, T) compare) {
  if (list.length <= 32) {
    for (var i = 1; i < list.length; i++) {
      final v = list[i];
      var j = i;
      while (j > 0 && compare(list[j - 1], v) > 0) {
        list[j] = list[j - 1];
        j--;
      }
      list[j] = v;
    }
    return;
  }
  final indexed = list.indexed.toList();
  indexed.sort((a, b) {
    final c = compare(a.$2, b.$2);
    return c != 0 ? c : a.$1.compareTo(b.$1);
  });
  for (var i = 0; i < list.length; i++) list[i] = indexed[i].$2;
}

class _Line {
  List<_Span> spans = [];
  double baseline, size = 0;
  bool math = false, bold = false, mono = false, used = false;
  Rect box;
  String role = '', text = '';
  List<String> cells = [];
  List<double> starts = [];
  List<Run> runs = [];
  _Line(this.box, [this.baseline = 0]);
}

int _runeCount(String s) => s.runes.length;
int _byteLength(String s) {
  var n = 0;
  for (final v in s.runes)
    n += v < 128
        ? 1
        : v < 2048
        ? 2
        : v < 65536
        ? 3
        : 4;
  return n;
}

String _deLigature(String s) => s.replaceAllMapped(
  _ligaturePattern,
  (m) => const {
    'ﬁ': 'fi',
    'ﬂ': 'fl',
    'ﬀ': 'ff',
    'ﬃ': 'ffi',
    'ﬄ': 'ffl',
    '\u00ad': '',
    '\u00a0': ' ',
  }[m[0]]!,
);
double _spanBaseline(_Span s) =>
    s.baseline != 0 ? s.baseline : s.box.y + s.box.height * .78;
double _bodyFontSize(List<_PageContent> pages) {
  final counts = <int, int>{};
  for (final pc in pages)
    for (final s in pc.spans)
      if (s.size > 0 && s.size < 100) {
        final k = (s.size * 2 + .5).floor();
        counts[k] = (counts[k] ?? 0) + _runeCount(s.text);
      }
  var best = 22, weight = 0;
  for (final e in counts.entries)
    if (e.value > weight || e.value == weight && e.key < best) {
      best = e.key;
      weight = e.value;
    }
  return best / 2;
}

List<_Line> _makeLines(List<_Span> spans) {
  final ordered = spans.map((s) => s.copy()).toList(), lines = <_Line>[];
  _stableSort(ordered, (a, b) => _spanBaseline(a).compareTo(_spanBaseline(b)));
  for (final s in ordered) {
    if (s.text.trim().isEmpty) continue;
    final baseline = _spanBaseline(s);
    _Line? target;
    final last = lines.lastOrNull;
    if (last != null &&
        (baseline - last.baseline).abs() <
            math.max(.6, math.min(s.size, last.size) * .25))
      target = last;
    if (target == null) {
      target = _Line(s.box, baseline);
      lines.add(target);
    } else {
      target.box = _union(target.box, s.box);
    }
    target.size = math.max(target.size, s.size);
    target.spans.add(s);
  }
  for (var i = 0; i < lines.length; i++) {
    final l = lines[i], kept = <_Span>[];
    for (final s in l.spans) {
      _Line? host;
      var best = double.infinity;
      final accent =
          s.script.isEmpty &&
          RegExp(r'^[\p{M}\s]*$', unicode: true).hasMatch(s.text);
      for (var j = math.max(0, i - 4); j < math.min(lines.length, i + 5); j++) {
        final h = lines[j], dy = _spanBaseline(s) - h.baseline;
        if (i == j ||
            !accent && h.size < s.size * 1.18 ||
            dy.abs() > h.size * .72 ||
            dy.abs() < h.size * .12)
          continue;
        final dx = math.max(
          h.box.x - s.box.x - s.box.width,
          s.box.x - h.box.x - h.box.width,
        );
        if (dx > h.size * .6) continue;
        final score = dy.abs() + math.max(0, dx);
        if (score < best) {
          host = h;
          best = score;
        }
      }
      if (host != null) {
        s.script = _spanBaseline(s) > host.baseline ? 'sub' : 'sup';
        host.spans.add(s);
        host.box = _union(host.box, s.box);
      } else {
        kept.add(s);
      }
    }
    l.spans = kept;
  }
  final out = lines.where((l) => l.spans.isNotEmpty).toList();
  for (final l in out) _finishLine(l);
  _stableSort(
    out,
    (a, b) => (a.baseline - b.baseline).abs() > .5
        ? a.baseline.compareTo(b.baseline)
        : a.box.x.compareTo(b.box.x),
  );
  return out;
}

void _finishLine(_Line l) {
  _stableSort(l.spans, (a, b) => a.box.x.compareTo(b.box.x));
  var text = '', cell = '';
  l.cells = [];
  l.starts = [];
  l.runs = [];
  l.text = '';
  final weights = <double, int>{};
  l.mono = true;
  l.math = false;
  l.bold = true;
  for (var j = 0; j < l.spans.length; j++) {
    final s = l.spans[j],
        t = _deLigature(s.text),
        prev = j > 0 ? l.spans[j - 1] : null,
        gap = prev != null ? s.box.x - prev.box.x - prev.box.width : 0;
    if (j == 0 || gap > math.max(8, s.size * 1.5)) {
      if (j > 0) {
        l.cells.add(cell.trim());
        cell = '';
      }
      l.starts.add(s.box.x);
    }
    final space =
        j > 0 &&
            gap > math.max(1, s.size * .15) &&
            !text.endsWith(' ') &&
            !t.startsWith(' ')
        ? ' '
        : '';
    text += space + t;
    cell += space + t;
    final last = l.runs.lastOrNull;
    if (last != null &&
        last.bold == s.bold &&
        last.italic == s.italic &&
        last.link == s.link &&
        last.script == s.script) {
      last.text += space + t;
    } else {
      l.runs.add(
        Run(
          text: space + t,
          bold: s.bold,
          italic: s.italic,
          link: s.link,
          script: s.script,
        ),
      );
    }
    if (s.script.isEmpty) {
      final size = (s.size * 10 + .5).floor() / 10;
      weights[size] = (weights[size] ?? 0) + _runeCount(t);
    }
    l.math = l.math || s.font?.math == true;
    l.bold = l.bold && s.bold;
    l.mono = l.mono && s.mono;
    if (s.role.isNotEmpty && s.role != 'Span') l.role = s.role;
  }
  if (weights.isEmpty)
    for (final s in l.spans) l.size = math.max(l.size, s.size);
  var best = 0;
  for (final e in weights.entries)
    if (e.value > best || e.value == best && e.key > l.size) {
      l.size = e.key;
      best = e.value;
    }
  l.cells.add(cell.trim());
  l.text = l.mono ? text.replaceFirst(RegExp(r'[ \t\r\n]+$'), '') : text.trim();
}

void _cleanMargins(List<_PageContent> pages) {
  if (pages.length < 2) return;
  final body = _bodyFontSize(pages),
      grouped = pages.map((p) => _makeLines(p.spans)).toList(),
      counts = <String, int>{};
  String key(_PageContent pc, _Line l) {
    if (l.size > body * 1.1 ||
        l.bold && l.size >= body * .98 ||
        _byteLength(l.text) > 180)
      return '';
    var side = 'top:';
    if (l.box.y + l.box.height < pc.page.height * .08) {
    } else if (l.box.y > pc.page.height * .94) {
      side = 'bottom:';
    } else {
      return '';
    }
    return side + l.text.trim().toLowerCase().replaceAll(RegExp(r'\d+'), '#');
  }

  for (var n = 0; n < grouped.length; n++) {
    final seen = <String>{};
    for (final l in grouped[n]) {
      final k = key(pages[n], l);
      if (k.isNotEmpty && seen.add(k)) counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  String position(_Span s) => '${s.box.x}:${s.box.y}:${s.text}';
  for (var n = 0; n < grouped.length; n++) {
    final drop = <String>{};
    for (final l in grouped[n]) {
      final k = key(pages[n], l);
      if (k.isNotEmpty &&
          ((counts[k] ?? 0) >=
                  math.max(2, math.min(6, (pages.length + 1) ~/ 2)) ||
              RegExp(
                r'^(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/)\s*\d+)?$',
                caseSensitive: false,
              ).hasMatch(l.text)))
        for (final s in l.spans) drop.add(position(s));
    }
    pages[n].spans = pages[n].spans
        .where((s) => !drop.contains(position(s)))
        .toList();
  }
}

List<_Line> _columnOrder(List<_Line> lines, double width) {
  final candidates = <double>[];
  for (final l in lines)
    for (var j = 1; j < l.spans.length; j++) {
      final a = l.spans[j - 1],
          b = l.spans[j],
          gap = b.box.x - a.box.x - a.box.width,
          mid = (b.box.x + a.box.x + a.box.width) / 2;
      if (gap > width * .035 && mid > width * .3 && mid < width * .7)
        candidates.add(mid);
    }
  for (var i = 0; i < lines.length; i++) {
    final l = lines[i];
    if (l.mono || l.box.width < width * .15) continue;
    for (
      var j = i + 1;
      j < lines.length && lines[j].baseline - l.baseline < l.size * .9;
      j++
    ) {
      final r = lines[j];
      if (r.mono || r.box.width < width * .15) continue;
      final (a, b) = l.box.x > r.box.x ? (r, l) : (l, r);
      final gap = b.box.x - a.box.x - a.box.width,
          mid = (b.box.x + a.box.x + a.box.width) / 2;
      if (gap > width * .015 && mid > width * .3 && mid < width * .7)
        candidates.add(mid);
    }
  }
  if (candidates.length < 3) return lines;
  candidates.sort();
  final cut = candidates[candidates.length ~/ 2], out = <_Line>[];
  var left = <_Line>[], right = <_Line>[];
  void flush() {
    out.addAll(left);
    out.addAll(right);
    left = [];
    right = [];
  }

  _Line part(List<_Span> spans) {
    final n = _Line(spans.first.box, _spanBaseline(spans.first))..spans = spans;
    for (final s in spans.skip(1)) n.box = _union(n.box, s.box);
    _finishLine(n);
    return n;
  }

  for (final l in lines) {
    final ls = <_Span>[], rs = <_Span>[];
    var cross = false;
    for (final s in l.spans) {
      if (s.box.x < cut && s.box.x + s.box.width > cut) cross = true;
      (s.box.x < cut ? ls : rs).add(s);
    }
    if (cross) {
      flush();
      out.add(l);
      continue;
    }
    if (ls.isNotEmpty) left.add(part(ls));
    if (rs.isNotEmpty) right.add(part(rs));
  }
  flush();
  return out;
}

(String, int, String) _classifyLine(_Line l, double body) {
  var role = '';
  switch (l.role) {
    case 'Formula':
      return ('math', 0, 'formula');
    case 'Code':
      return ('code', 0, '');
    case 'H':
    case 'H1':
      return ('heading', 1, '');
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return ('heading', int.parse(l.role[1]), '');
    case 'LI':
    case 'LBody':
      return ('list', 0, '');
    case 'Caption':
      role = 'caption';
    case 'Note':
      role = 'footnote';
    case 'Reference':
    case 'BibEntry':
      role = 'reference';
    case 'Index':
      role = 'index';
  }
  if (l.mono && _runeCount(l.text) > 0) return ('code', 0, role);
  final n = _byteLength(l.text);
  if (l.bold &&
      l.size >= body * .8 &&
      n < 150 &&
      RegExp(
        r'^(?:[A-Z]|\d+)(?:\.\d+){1,3}\s+\p{L}',
        unicode: true,
      ).hasMatch(l.text))
    return ('heading', 3, role);
  if (n < 200 &&
      (l.size >= body * 1.18 && l.size - body >= 1 ||
          l.bold &&
              n < 80 &&
              l.text.trim().split(RegExp(r'\s+')).length <= 10 &&
              l.size >= body * .98 &&
              !RegExp(r'[.,]$').hasMatch(l.text)))
    return (
      'heading',
      l.size >= body * 1.65
          ? 1
          : l.size < body * 1.25
          ? 3
          : 2,
      role,
    );
  if (RegExp(r'^(?:[•●▪◦‣]|[-*]\s|\d+[.)]\s)').hasMatch(l.text))
    return ('list', 0, role);
  if (RegExp(r'^(figure|table) ', caseSensitive: false).hasMatch(l.text) &&
      l.size < body * 1.05)
    role = 'caption';
  if (l.size < body * .82 && role.isEmpty) role = 'footnote';
  return ('paragraph', 0, role);
}

bool _canDehyphenate(String a, String b) =>
    RegExp(r'\p{L}-$', unicode: true).hasMatch(a) &&
    RegExp(r'^\p{Ll}', unicode: true).hasMatch(b);
bool _endsSoftHyphen(_Line l) =>
    l.spans.lastOrNull?.text.trim().endsWith('\u00ad') == true;
Set<String> _pageWords(List<_Line> lines) {
  final words = <String>{};
  for (final l in lines)
    if (!l.mono && !l.math)
      for (final w in l.text.split(RegExp(r'[^\p{L}-]+', unicode: true)))
        if (_byteLength(w) > 2 && !w.endsWith('-')) words.add(w.toLowerCase());
  return words;
}

bool _witnessedHyphen(String a, String b, Set<String> words) {
  if (!_canDehyphenate(a, b)) return false;
  final prefix = RegExp(
        r'(\p{L}+)-$',
        unicode: true,
      ).firstMatch(a)?[1]?.toLowerCase(),
      suffix = RegExp(
        r'^\p{L}+',
        unicode: true,
      ).firstMatch(b)?[0]?.toLowerCase();
  return prefix != null &&
      suffix != null &&
      words.contains(prefix + suffix) &&
      !words.contains('$prefix-$suffix');
}

String _codeLanguage(String text) {
  final t = text.trim();
  if (t.contains('package ') && (t.contains('func ') || t.contains('import ')))
    return 'go';
  if (t.contains('def ') && t.contains(':')) return 'python';
  if (RegExp(r'#include|std::').hasMatch(t)) return 'cpp';
  if (t.contains('fn ') && (t.contains('let ') || t.contains('->')))
    return 'rust';
  if (RegExp(r'interface |: string|: number').hasMatch(t)) return 'typescript';
  if (RegExp(r'const |function |console\.log\(').hasMatch(t))
    return 'javascript';
  if (t.toUpperCase().contains('SELECT ') && t.toUpperCase().contains(' FROM '))
    return 'sql';
  if (t.startsWith('#!/bin/') || t.startsWith(r'$ ')) return 'bash';
  if (t.startsWith('{\n') && t.contains('\":')) return 'json';
  if (t.contains('<html') || t.contains('<!DOCTYPE')) return 'html';
  return '';
}
