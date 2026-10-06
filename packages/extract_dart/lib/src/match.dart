/// Fast matching for the class/id patterns of the TypeScript engine.
///
/// Most of those patterns are alternations of literal words, optionally
/// delimited: `(?:^|[\s_-])(?:footnotes|endnotes)(?:$|[\s_-])`. The Dart VM
/// runs regular expressions far slower than V8 (interpreted in AOT builds),
/// and the engine tests every element's class and id against dozens of them,
/// so [ClassPattern] derives the words from the pattern source and matches
/// with plain string search. Patterns it cannot reduce fall back to the
/// `RegExp`, memoized by subject. With assertions enabled every call is
/// checked against the `RegExp`.
library;

import 'js.dart';

enum _Bound {
  /// Anywhere.
  none,

  /// `(?:^|\s)word(?:\s|$)`.
  space,

  /// `(?:^|[\s_-])word(?:$|[\s_-])`.
  spaceDash,

  /// `(?:\b|_)word(?:\b|_)`.
  wordEdge,
}

/// One literal alternative: [word], optionally anchored at either end.
class _Literal {
  const _Literal(this.word, this.start, this.end);

  final String word;
  final bool start;
  final bool end;
}

class ClassPattern {
  ClassPattern(String source, {bool caseSensitive = true})
    : regex = RegExp(source, caseSensitive: caseSensitive),
      _plan = caseSensitive ? _Plan.parse(source) : null;

  final RegExp regex;
  final _Plan? _plan;

  /// Whether the pattern reduced to literal-word matching (no `RegExp` at run time).
  bool get isLiteral => _plan != null;
  final Map<String, bool> _memo = {};

  bool hasMatch(String subject) {
    final cached = _memo[subject];
    if (cached != null) return cached;
    final plan = _plan;
    final result = plan != null ? plan.matches(subject) : regex.hasMatch(subject);
    assert(result == regex.hasMatch(subject), 'ClassPattern ${regex.pattern} disagrees with RegExp on "$subject"');
    if (_memo.length >= 4096) _memo.clear();
    return _memo[subject] = result;
  }
}

class _Plan {
  _Plan(this.bound, this.words, this.literals)
    : _literalIndex = _index(literals, (l) => l.word),
      _wordIndex = _index(words, (w) => w);

  final _Bound bound;

  /// Delimited words (for [bound] other than none).
  final List<String> words;

  /// Undelimited alternatives (`|codeBlockTitle`, `^hid$`, plain words).
  final List<_Literal> literals;

  static const _prefixes = {
    r'(?:^|[\s_-])(?:': _Bound.spaceDash,
    r'(?:^|\s)(?:': _Bound.space,
    r'(?:\b|_)(?:': _Bound.wordEdge,
  };
  static const _suffixes = {
    _Bound.spaceDash: r')(?:$|[\s_-])',
    _Bound.space: r')(?:\s|$)',
    _Bound.wordEdge: r')(?:\b|_)',
  };

  /// Null when the source is not a (delimited) alternation of literals.
  static _Plan? parse(String source) {
    try {
      for (final MapEntry(key: prefix, value: bound) in _prefixes.entries) {
        if (!source.startsWith(prefix)) continue;
        final close = _closingParen(source, prefix.length - 3);
        final suffix = _suffixes[bound]!;
        if (!source.startsWith(suffix, close)) return null;
        final words = _expand(source.substring(prefix.length, close));
        final rest = source.substring(close + suffix.length);
        if (words == null || words.contains('')) return null;
        if (rest.isEmpty) return _Plan(bound, words, const []);
        if (!rest.startsWith('|')) return null;
        final literals = _literals(rest.substring(1));
        return literals == null ? null : _Plan(bound, words, literals);
      }
      // `(?:^|\s)word(?:\s|$)` without a group.
      const spacePrefix = r'(?:^|\s)';
      const spaceSuffix = r'(?:\s|$)';
      if (source.startsWith(spacePrefix) && source.endsWith(spaceSuffix)) {
        final words = _expand(source.substring(spacePrefix.length, source.length - spaceSuffix.length));
        return words == null || words.contains('') ? null : _Plan(_Bound.space, words, const []);
      }
      final literals = _literals(source);
      return literals == null ? null : _Plan(_Bound.none, const [], literals);
    } on FormatException {
      return null;
    }
  }

  static int _closingParen(String s, int open) {
    var depth = 0;
    for (var i = open; i < s.length; i++) {
      final c = s.codeUnitAt(i);
      if (c == 0x5c) {
        i++;
      } else if (c == 0x28) {
        depth++;
      } else if (c == 0x29) {
        depth--;
        if (depth == 0) return i;
      }
    }
    throw const FormatException('unbalanced');
  }

  /// Top-level alternatives, each a literal with optional `^`/`$` anchors.
  static List<_Literal>? _literals(String source) {
    final out = <_Literal>[];
    for (final alternative in _split(source)) {
      var body = alternative;
      final start = body.startsWith('^');
      if (start) body = body.substring(1);
      final end = body.endsWith(r'$') && !body.endsWith(r'\$');
      if (end) body = body.substring(0, body.length - 1);
      final words = _expand(body);
      if (words == null || words.contains('')) return null;
      for (final word in words) {
        out.add(_Literal(word, start, end));
      }
    }
    return out;
  }

  /// Splits on top-level `|`.
  static List<String> _split(String source) {
    final out = <String>[];
    var depth = 0;
    var from = 0;
    for (var i = 0; i < source.length; i++) {
      final c = source.codeUnitAt(i);
      if (c == 0x5c) {
        i++;
      } else if (c == 0x28) {
        depth++;
      } else if (c == 0x29) {
        depth--;
      } else if (c == 0x7c && depth == 0) {
        out.add(source.substring(from, i));
        from = i + 1;
      }
    }
    out.add(source.substring(from));
    return out;
  }

  /// Every string an alternation of literals (with `x?`, `(?:a|b)` and
  /// `(?:...)?`) matches; null for anything else.
  static List<String>? _expand(String source) {
    final out = <String>[];
    for (final alternative in _split(source)) {
      final words = _sequence(alternative);
      if (words == null) return null;
      out.addAll(words);
    }
    return out;
  }

  static List<String>? _sequence(String s) {
    var results = <String>[''];
    var i = 0;
    while (i < s.length) {
      final c = s.codeUnitAt(i);
      List<String> atom;
      if (c == 0x28) {
        if (!s.startsWith('(?:', i)) return null;
        final close = _closingParen(s, i);
        final inner = _expand(s.substring(i + 3, close));
        if (inner == null) return null;
        atom = inner;
        i = close + 1;
      } else if (c == 0x5c) {
        if (i + 1 >= s.length) return null;
        final escaped = s[i + 1];
        // Only escaped punctuation is a literal.
        if (!r'.-/\$^|()[]{}*+?'.contains(escaped)) return null;
        atom = [escaped];
        i += 2;
      } else if (r'.^$[]{}*+|)'.contains(s[i])) {
        return null;
      } else {
        atom = [s[i]];
        i++;
      }
      if (i < s.length && s.codeUnitAt(i) == 0x3f) {
        atom = ['', ...atom];
        i++;
      }
      results = [
        for (final prefix in results)
          for (final suffix in atom) prefix + suffix,
      ];
    }
    return results;
  }

  /// Literals and words by first code unit (all ASCII in practice), for a
  /// single pass over the subject.
  final List<List<_Literal>?> _literalIndex;
  final List<List<String>?> _wordIndex;

  static List<List<T>?> _index<T>(List<T> items, String Function(T) word) {
    final out = List<List<T>?>.filled(128, null);
    for (final item in items) {
      final c = word(item).codeUnitAt(0);
      // Non-ASCII words fall back to the RegExp (`parse` catches this).
      if (c >= 128) throw const FormatException('non-ASCII word');
      (out[c] ??= []).add(item);
    }
    return out;
  }

  bool matches(String s) {
    final n = s.length;
    final literalIndex = _literalIndex;
    final wordIndex = _wordIndex;
    for (var i = 0; i < n; i++) {
      final c = s.codeUnitAt(i);
      if (c >= 128) continue;
      final candidates = literalIndex[c];
      if (candidates != null) {
        for (final literal in candidates) {
          final word = literal.word;
          if (!s.startsWith(word, i)) continue;
          if (literal.start && i != 0) continue;
          if (literal.end && i + word.length != n) continue;
          return true;
        }
      }
      final starts = wordIndex[c];
      if (starts != null && _before(s, i)) {
        for (final word in starts) {
          final end = i + word.length;
          if (s.startsWith(word, i) && (end == n || _delimiter(s.codeUnitAt(end)))) return true;
        }
      }
    }
    return false;
  }

  bool _before(String s, int i) {
    if (i == 0) return true;
    final c = s.codeUnitAt(i - 1);
    return _delimiter(c);
  }

  bool _delimiter(int c) => switch (bound) {
    _Bound.space => isJsSpace(c),
    _Bound.spaceDash => isJsSpace(c) || c == 0x5f || c == 0x2d,
    _Bound.wordEdge => c == 0x5f || !_isWordChar(c),
    _Bound.none => true,
  };

  static bool _isWordChar(int c) =>
      (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;
}
