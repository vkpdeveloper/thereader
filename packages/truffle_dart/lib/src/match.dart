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

import 'dart:typed_data';

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
  /// [memoize]: remember results by subject (class and id strings repeat; running text does not).
  ClassPattern(String source, {bool caseSensitive = true, this.memoize = true})
    : regex = RegExp(source, caseSensitive: caseSensitive),
      _plan = caseSensitive ? _Plan.parse(source) : null;

  final RegExp regex;
  final _Plan? _plan;
  final bool memoize;

  /// Whether the pattern reduced to literal-word matching (no `RegExp` at run time).
  bool get isLiteral => _plan != null;
  final Map<String, bool> _memo = {};

  /// The last subject and its result: elements without class or id all
  /// share one match string, and are asked about in runs.
  String? _last;
  bool _lastResult = false;

  bool hasMatch(String subject) {
    if (identical(subject, _last)) return _lastResult;
    final cached = memoize ? _memo[subject] : null;
    if (cached != null) return _remember(subject, cached);
    final plan = _plan;
    final result = plan != null ? plan.matches(subject) : regex.hasMatch(subject);
    assert(result == regex.hasMatch(subject), 'ClassPattern ${regex.pattern} disagrees with RegExp on "$subject"');
    if (!memoize) return result;
    if (_memo.length >= 4096) _memo.clear();
    _memo[subject] = result;
    return _remember(subject, result);
  }

  bool _remember(String subject, bool result) {
    _last = subject;
    _lastResult = result;
    return result;
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
        for (var k = 0; k < candidates.length; k++) {
          final literal = candidates[k];
          final word = literal.word;
          if (!_startsWith(s, word, i)) continue;
          if (literal.start && i != 0) continue;
          if (literal.end && i + word.length != n) continue;
          return true;
        }
      }
      final starts = wordIndex[c];
      if (starts != null && _before(s, i)) {
        for (var k = 0; k < starts.length; k++) {
          final word = starts[k];
          final end = i + word.length;
          if (_startsWith(s, word, i) && (end == n || _delimiter(s.codeUnitAt(end)))) return true;
        }
      }
    }
    return false;
  }

  /// `s.startsWith(word, i)`, where the first code units are known to match.
  static bool _startsWith(String s, String word, int i) {
    if (i + word.length > s.length) return false;
    for (var k = 1; k < word.length; k++) {
      if (s.codeUnitAt(i + k) != word.codeUnitAt(k)) return false;
    }
    return true;
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

// ------------------------------------------------------------ required literals

/// Strings one of which every match of [regex] contains, derived from its
/// source (lowercase when it ignores case); null when the source requires no
/// literal or uses syntax the derivation does not cover (it then claims
/// nothing). A pattern run over text that contains none of them cannot
/// match, and the strings are found far faster than the Dart VM runs the
/// pattern.
List<String>? requiredLiterals(RegExp regex) {
  if (regex.isUnicode) return null;
  try {
    final parser = _LiteralParser(regex.pattern, !regex.isCaseSensitive);
    final info = parser.alternation();
    if (parser.i != regex.pattern.length) return null;
    final required = info.required;
    if (required == null) return null;
    // A string that contains another member adds nothing.
    return List.unmodifiable(required.where((w) => !required.any((v) => v != w && w.contains(v))));
  } on FormatException {
    return null;
  }
}

/// A [RegExp] whose [requiredLiterals] are looked for first: a subject
/// without any of them cannot match and is answered without running the
/// pattern (with assertions enabled, the pattern is checked as well).
class ScreenedPattern {
  ScreenedPattern(String source, {bool caseSensitive = true})
    : regex = RegExp(source, caseSensitive: caseSensitive),
      _byFirst = _index(requiredLiterals(RegExp(source, caseSensitive: caseSensitive)));

  final RegExp regex;

  /// The literals by first code unit (lowercase when ignoring case); null
  /// when there are none, or one starts outside ASCII.
  final List<List<String>?>? _byFirst;

  static List<List<String>?>? _index(List<String>? literals) {
    if (literals == null || literals.any((w) => w.codeUnitAt(0) >= 0x80)) return null;
    final out = List<List<String>?>.filled(128, null);
    for (final literal in literals) {
      (out[literal.codeUnitAt(0)] ??= []).add(literal);
    }
    return out;
  }

  /// False when [subject] cannot match.
  bool mayMatch(String subject) {
    final byFirst = _byFirst;
    if (byFirst == null || _containsAny(subject, byFirst)) return true;
    assert(!regex.hasMatch(subject), '${regex.pattern} matches "$subject" without its literals');
    return false;
  }

  bool hasMatch(String subject) => mayMatch(subject) && regex.hasMatch(subject);

  RegExpMatch? firstMatch(String subject) => mayMatch(subject) ? regex.firstMatch(subject) : null;

  bool _containsAny(String s, List<List<String>?> byFirst) {
    final ignoreCase = !regex.isCaseSensitive;
    for (var i = 0; i < s.length; i++) {
      var c = s.codeUnitAt(i);
      if (ignoreCase) c = _asciiLower(c);
      if (c >= 0x80) continue;
      final candidates = byFirst[c];
      if (candidates == null) continue;
      for (final literal in candidates) {
        if (i + literal.length > s.length) continue;
        var k = 1;
        while (k < literal.length) {
          final d = s.codeUnitAt(i + k);
          if ((ignoreCase ? _asciiLower(d) : d) != literal.codeUnitAt(k)) break;
          k++;
        }
        if (k == literal.length) return true;
      }
    }
    return false;
  }
}

int _asciiLower(int c) => c >= 0x41 && c <= 0x5a ? c + 32 : c;

/// What a regular expression node implies about the text it matches.
class _Info {
  _Info(this.exact, Set<String>? required)
    : required = exact != null && !exact.contains('') && _better(exact, required) ? exact : required;

  /// Every string the node matches, when they are few and short; else null.
  final Set<String>? exact;

  /// Strings one of which every match contains; null when none is known.
  final Set<String>? required;

  static final any = _Info(null, null);
  static final empty = _Info({''}, null);

  /// The longer the shortest string, the fewer texts contain one.
  static bool _better(Set<String> candidate, Set<String>? current) {
    if (current == null) return true;
    int shortest(Set<String> s) => s.fold(1 << 30, (n, w) => w.length < n ? w.length : n);
    final a = shortest(candidate);
    final b = shortest(current);
    return a > b || a == b && candidate.length < current.length;
  }
}

/// Recursive descent over the ECMAScript (non-unicode) pattern syntax the
/// engine uses.
class _LiteralParser {
  _LiteralParser(this.s, this.ignoreCase);

  final String s;
  final bool ignoreCase;
  var i = 0;

  static const _maxExact = 16;
  static const _maxLength = 32;

  _Info alternation() {
    final alternatives = [sequence()];
    while (i < s.length && s.codeUnitAt(i) == 0x7c) {
      i++;
      alternatives.add(sequence());
    }
    if (alternatives.length == 1) return alternatives.first;
    Set<String>? exact = {};
    Set<String>? required = {};
    for (final alternative in alternatives) {
      exact = exact == null || alternative.exact == null ? null : {...exact, ...alternative.exact!};
      required = required == null || alternative.required == null ? null : {...required, ...alternative.required!};
    }
    return _Info(exact != null && exact.length <= _maxExact ? exact : null, required);
  }

  _Info sequence() {
    Set<String>? best;
    void consider(Set<String>? candidate) {
      if (candidate != null && !candidate.contains('') && _Info._better(candidate, best)) best = candidate;
    }

    // Exact strings of the current run of finite atoms, which a match holds contiguously.
    var run = <String>{''};
    var finite = true;
    while (i < s.length) {
      final c = s.codeUnitAt(i);
      if (c == 0x7c || c == 0x29) break;
      final atom = quantified(this.atom());
      final exact = atom.exact;
      if (exact != null) {
        final product = {
          for (final a in run)
            for (final b in exact) a + b,
        };
        if (product.length <= _maxExact && product.every((w) => w.length <= _maxLength)) {
          run = product;
          continue;
        }
      }
      finite = false;
      consider(run);
      consider(atom.required);
      run = exact ?? {''};
    }
    consider(run);
    return _Info(finite ? run : null, best);
  }

  _Info quantified(_Info atom) {
    if (i >= s.length) return atom;
    final c = s.codeUnitAt(i);
    int min;
    int max;
    if (c == 0x2a) {
      (min, max) = (0, -1);
      i++;
    } else if (c == 0x2b) {
      (min, max) = (1, -1);
      i++;
    } else if (c == 0x3f) {
      (min, max) = (0, 1);
      i++;
    } else if (c == 0x7b) {
      final m = _braces.matchAsPrefix(s, i);
      if (m == null) return atom;
      min = int.parse(m[1]!);
      max = m[2] == null ? min : (m[3] == null ? -1 : int.parse(m[3]!));
      i = m.end;
    } else {
      return atom;
    }
    if (i < s.length && s.codeUnitAt(i) == 0x3f) i++;
    if (min == 0) return max == 1 && atom.exact != null ? _Info({'', ...atom.exact!}, null) : _Info.any;
    if (min == 1 && max == 1) return atom;
    return _Info(null, atom.required);
  }

  static final _braces = RegExp(r'\{(\d+)(,(\d*))?\}');

  _Info atom() {
    final c = s.codeUnitAt(i);
    switch (c) {
      case 0x28: // (
        var lookaround = false;
        if (s.startsWith('(?:', i)) {
          i += 3;
        } else if (s.startsWith('(?=', i) || s.startsWith('(?!', i)) {
          lookaround = true;
          i += 3;
        } else if (s.startsWith('(?<=', i) || s.startsWith('(?<!', i)) {
          lookaround = true;
          i += 4;
        } else if (s.startsWith('(?', i)) {
          throw const FormatException('group syntax');
        } else {
          i++;
        }
        final inner = alternation();
        if (i >= s.length || s.codeUnitAt(i) != 0x29) throw const FormatException('unbalanced');
        i++;
        return lookaround ? _Info.empty : inner;
      case 0x5b: // [
        i++;
        if (i < s.length && s.codeUnitAt(i) == 0x5e) i++;
        while (i < s.length && s.codeUnitAt(i) != 0x5d) {
          if (s.codeUnitAt(i) == 0x5c) i++;
          i++;
        }
        if (i >= s.length) throw const FormatException('unterminated class');
        i++;
        return _Info.any;
      case 0x2e: // .
        i++;
        return _Info.any;
      case 0x5e || 0x24: // ^ $
        i++;
        return _Info.empty;
      case 0x5c: // \
        if (i + 1 >= s.length) throw const FormatException('trailing backslash');
        final e = s.codeUnitAt(i + 1);
        i += 2;
        switch (e) {
          case 0x62 || 0x42: // \b \B
            return _Info.empty;
          case 0x64 || 0x44 || 0x77 || 0x57 || 0x73 || 0x53: // \d \D \w \W \s \S
            return _Info.any;
          case 0x6e:
            return _literal(0x0a);
          case 0x72:
            return _literal(0x0d);
          case 0x74:
            return _literal(0x09);
          case 0x66:
            return _literal(0x0c);
          case 0x76:
            return _literal(0x0b);
          case 0x75: // \uXXXX
            final hex = i + 4 <= s.length ? int.tryParse(s.substring(i, i + 4), radix: 16) : null;
            if (hex == null) throw const FormatException('escape');
            i += 4;
            return _literal(hex);
        }
        // Escaped punctuation is the character itself; other escapes are not covered.
        if (e < 0x80 && !_isWordChar(e)) return _literal(e);
        throw const FormatException('escape');
      case 0x2a || 0x2b || 0x3f: // * + ?
        throw const FormatException('nothing to repeat');
      case 0x7b: // {
        if (_braces.matchAsPrefix(s, i) != null) throw const FormatException('nothing to repeat');
    }
    i++;
    return _literal(c);
  }

  _Info _literal(int c) {
    if (ignoreCase) {
      if (c >= 0x41 && c <= 0x5a) return _Info({String.fromCharCode(c + 32)}, null);
      // Other letters may fold to their case variants.
      if (c >= 0x80) return _Info.any;
    }
    return _Info({String.fromCharCode(c)}, null);
  }

  static bool _isWordChar(int c) =>
      (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;
}

/// One subject searched for many [requiredLiterals] sets: a bitset of its
/// code units and adjacent pairs (ASCII letters lowercased, folded to seven
/// bits) rules most absent strings out without a search.
class LiteralScreen {
  LiteralScreen(this.subject) {
    var previous = -1;
    for (var i = 0; i < subject.length; i++) {
      final c = _fold(subject.codeUnitAt(i));
      _singles[c >> 5] |= 1 << (c & 31);
      if (previous >= 0) {
        final pair = previous << 7 | c;
        _pairs[pair >> 5] |= 1 << (pair & 31);
      }
      previous = c;
    }
  }

  final String subject;
  final _singles = Uint32List(4);
  final _pairs = Uint32List(512);
  String? _lower;

  static int _fold(int c) => (c >= 0x41 && c <= 0x5a ? c + 32 : c) & 0x7f;

  /// Whether [subject] contains one of [literals]; with [ignoreCase] (the
  /// literals are lowercase), its ASCII-lowercased form does.
  bool containsAny(List<String> literals, {bool ignoreCase = false}) {
    for (final literal in literals) {
      if (!_mayContain(literal)) continue;
      final text = ignoreCase ? _lower ??= _asciiLower(subject) : subject;
      if (text.contains(literal)) return true;
    }
    return false;
  }

  bool _mayContain(String literal) {
    var previous = _fold(literal.codeUnitAt(0));
    if (_singles[previous >> 5] & (1 << (previous & 31)) == 0) return false;
    for (var i = 1; i < literal.length; i++) {
      final c = _fold(literal.codeUnitAt(i));
      final pair = previous << 7 | c;
      if (_pairs[pair >> 5] & (1 << (pair & 31)) == 0) return false;
      previous = c;
    }
    return true;
  }

  static String _asciiLower(String s) {
    for (var i = 0; i < s.length; i++) {
      final c = s.codeUnitAt(i);
      if (c >= 0x41 && c <= 0x5a) {
        final units = s.codeUnits.toList();
        for (var j = i; j < units.length; j++) {
          final u = units[j];
          if (u >= 0x41 && u <= 0x5a) units[j] = u + 32;
        }
        return String.fromCharCodes(units);
      }
    }
    return s;
  }
}
