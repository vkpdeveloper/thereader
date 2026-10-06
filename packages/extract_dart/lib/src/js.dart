/// JavaScript semantics the TypeScript engine relies on where Dart differs,
/// so the port produces the same output for the same input: whitespace and
/// `trim`, `toLowerCase`, `split`, `Number()`, `parseInt`, number formatting
/// and `decodeURIComponent`. Dart's `RegExp` is ECMAScript's (the VM runs
/// irregexp), so patterns behave the same as long as the flags match.
library;

/// JavaScript `WhiteSpace` and `LineTerminator`: what `\s` and `trim()`
/// match. Unlike Dart's `trim`, U+0085 is not whitespace.
bool isJsSpace(int c) =>
    c == 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c == 0xa0 ||
    c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c == 0x2028 ||
    c == 0x2029 ||
    c == 0x202f ||
    c == 0x205f ||
    c == 0x3000 ||
    c == 0xfeff;

/// `String.prototype.trim`.
String jsTrim(String s) {
  var start = 0;
  var end = s.length;
  while (start < end && isJsSpace(s.codeUnitAt(start))) {
    start++;
  }
  while (end > start && isJsSpace(s.codeUnitAt(end - 1))) {
    end--;
  }
  return start == 0 && end == s.length ? s : s.substring(start, end);
}

/// True when `s.trim()` is empty.
bool isBlank(String s) {
  for (var i = 0; i < s.length; i++) {
    if (!isJsSpace(s.codeUnitAt(i))) return false;
  }
  return true;
}

/// `s.charCodeAt(i)`, with -1 standing in for `NaN` past either end.
int charCodeAt(String s, int i) => i >= 0 && i < s.length ? s.codeUnitAt(i) : -1;

/// `s.slice(start, end)` for non-negative indices: clamps instead of throwing.
String jsSlice(String s, int start, [int? end]) {
  final n = s.length;
  final a = start > n ? n : start;
  var b = end == null || end > n ? n : end;
  if (b < a) b = a;
  return a == 0 && b == n ? s : s.substring(a, b);
}

/// `s.split(pattern)`: an empty string splits into `['']`, as in JavaScript
/// (Dart returns an empty list).
List<String> jsSplit(String s, Pattern pattern) => s.isEmpty ? [''] : s.split(pattern);

final _letter = RegExp(r'\p{L}', unicode: true);

/// `String.prototype.toLowerCase`: Dart lowercases without the
/// language-independent special casings JavaScript applies (`İ` becomes
/// `i̇`, a word-final `Σ` becomes `ς`).
String jsLower(String s) {
  var ascii = true;
  for (var i = 0; i < s.length; i++) {
    if (s.codeUnitAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s.toLowerCase();
  if (!s.contains('İ') && !s.contains('Σ')) return s.toLowerCase();
  final out = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    if (c == 0x130) {
      out.write('i̇');
    } else if (c == 0x3a3) {
      out.write(_finalSigma(s, i) ? 'ς' : 'σ');
    } else {
      // Lowercase one code point at a time (surrogate pairs stay together).
      final end = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? i + 2 : i + 1;
      out.write(s.substring(i, end).toLowerCase());
      i = end - 1;
    }
  }
  return out.toString();
}

/// Unicode `Final_Sigma`: a cased letter before (case-ignorable characters
/// skipped) and none after.
bool _finalSigma(String s, int i) {
  bool cased(int j) => _letter.hasMatch(s[j]);
  bool ignorable(int c) =>
      c == 0x27 || c == 0x2e || c == 0x3a || c == 0xad || c == 0x2019 || (c >= 0x300 && c <= 0x36f);
  var j = i - 1;
  while (j >= 0 && ignorable(s.codeUnitAt(j))) {
    j--;
  }
  if (j < 0 || !cased(j)) return false;
  j = i + 1;
  while (j < s.length && ignorable(s.codeUnitAt(j))) {
    j++;
  }
  return j >= s.length || !cased(j);
}

/// `String.prototype.toUpperCase` for the ASCII values the engine uppercases.
String jsUpper(String s) => s.toUpperCase();

final _decimal = RegExp(r'^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$');
final _radix = RegExp(r'^0([xXoObB])([0-9a-fA-F]+)$');

/// `Number(value)` for a string (`null` is `Number(null)`, i.e. 0): strict,
/// `''` is 0, `'12px'` is NaN.
double jsNumber(String? value) {
  if (value == null) return 0;
  final s = jsTrim(value);
  if (s.isEmpty) return 0;
  if (_decimal.hasMatch(s)) return double.parse(s);
  final radix = _radix.firstMatch(s);
  if (radix != null) {
    final base = switch (radix.group(1)!.toLowerCase()) {
      'x' => 16,
      'o' => 8,
      _ => 2,
    };
    final n = BigInt.tryParse(radix.group(2)!, radix: base);
    return n == null ? double.nan : n.toDouble();
  }
  return switch (s) {
    'Infinity' || '+Infinity' => double.infinity,
    '-Infinity' => double.negativeInfinity,
    _ => double.nan,
  };
}

/// `parseInt(value, 10)`: leading digits after optional whitespace and sign;
/// NaN when there are none.
double jsParseInt(String value) {
  var i = 0;
  while (i < value.length && isJsSpace(value.codeUnitAt(i))) {
    i++;
  }
  var negative = false;
  if (i < value.length && (value.codeUnitAt(i) == 0x2b || value.codeUnitAt(i) == 0x2d)) {
    negative = value.codeUnitAt(i) == 0x2d;
    i++;
  }
  final start = i;
  while (i < value.length && value.codeUnitAt(i) >= 0x30 && value.codeUnitAt(i) <= 0x39) {
    i++;
  }
  if (i == start) return double.nan;
  final n = double.parse(value.substring(start, i));
  return negative ? -n : n;
}

/// `Number.isInteger`.
bool jsIsInteger(double n) => n.isFinite && n == n.truncateToDouble();

/// A JavaScript number as the model stores it: integral values as `int`.
num jsNum(double n) => jsIsInteger(n) && n.abs() < 9007199254740992 ? n.toInt() : n;

/// `String(number)`. Dart prints doubles like JavaScript except for the `.0`
/// of integral values and the sign of zero.
String jsNumberToString(num n) {
  if (n is int) return n.toString();
  final d = n.toDouble();
  if (d == 0) return '0';
  final s = d.toString();
  return s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
}

int _hexValue(int c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/// `decodeURIComponent`; null where JavaScript throws a `URIError`.
String? jsDecodeUriComponent(String s) {
  if (!s.contains('%')) return s;
  final out = StringBuffer();
  int byteAt(int k) {
    if (k + 2 >= s.length || s.codeUnitAt(k) != 0x25) return -1;
    final hi = _hexValue(s.codeUnitAt(k + 1));
    final lo = _hexValue(s.codeUnitAt(k + 2));
    return hi < 0 || lo < 0 ? -1 : hi * 16 + lo;
  }

  var i = 0;
  while (i < s.length) {
    final c = s.codeUnitAt(i);
    if (c != 0x25) {
      out.writeCharCode(c);
      i++;
      continue;
    }
    final b = byteAt(i);
    if (b < 0) return null;
    i += 3;
    if (b < 0x80) {
      out.writeCharCode(b);
      continue;
    }
    int n;
    int cp;
    int min;
    if (b & 0xe0 == 0xc0) {
      n = 1;
      cp = b & 0x1f;
      min = 0x80;
    } else if (b & 0xf0 == 0xe0) {
      n = 2;
      cp = b & 0x0f;
      min = 0x800;
    } else if (b & 0xf8 == 0xf0) {
      n = 3;
      cp = b & 0x07;
      min = 0x10000;
    } else {
      return null;
    }
    for (var k = 0; k < n; k++) {
      final next = byteAt(i);
      if (next < 0 || next & 0xc0 != 0x80) return null;
      cp = (cp << 6) | (next & 0x3f);
      i += 3;
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out.writeCharCode(cp);
  }
  return out.toString();
}

/// `for (const key in object)` order: array-index keys first, ascending,
/// then the other keys in insertion order.
Iterable<String> jsKeys(Map<String, Object?> map) {
  List<String>? indices;
  for (final key in map.keys) {
    if (_isArrayIndex(key)) (indices ??= []).add(key);
  }
  if (indices == null) return map.keys;
  indices.sort((a, b) => int.parse(a).compareTo(int.parse(b)));
  return [...indices, ...map.keys.where((key) => !_isArrayIndex(key))];
}

bool _isArrayIndex(String key) {
  if (key.isEmpty || key.length > 10) return false;
  for (var i = 0; i < key.length; i++) {
    final c = key.codeUnitAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  if (key.length > 1 && key.codeUnitAt(0) == 0x30) return false;
  return int.parse(key) < 4294967295;
}

bool _isHtmlSpace(int c) => c == 32 || c == 10 || c == 9 || c == 13 || c == 12;

/// `s.replace(/[\t\n\f\r ]+/g, ' ')`.
String collapseHtmlSpace(String s) {
  final n = s.length;
  var i = 0;
  // Fast path: nothing to replace.
  for (; i < n; i++) {
    final c = s.codeUnitAt(i);
    if (c == 32) {
      if (i + 1 < n && _isHtmlSpace(s.codeUnitAt(i + 1))) break;
    } else if (c == 10 || c == 9 || c == 13 || c == 12) {
      break;
    }
  }
  if (i == n) return s;
  final out = StringBuffer(s.substring(0, i));
  while (i < n) {
    final c = s.codeUnitAt(i);
    if (_isHtmlSpace(c)) {
      out.writeCharCode(32);
      i++;
      while (i < n && _isHtmlSpace(s.codeUnitAt(i))) {
        i++;
      }
    } else {
      final start = i;
      while (i < n && !_isHtmlSpace(s.codeUnitAt(i))) {
        i++;
      }
      out.write(s.substring(start, i));
    }
  }
  return out.toString();
}

/// Whitespace-separated (`\s+`) tokens of [s] include [token].
bool hasToken(String s, String token) {
  final n = s.length;
  var i = 0;
  while (i < n) {
    while (i < n && isJsSpace(s.codeUnitAt(i))) {
      i++;
    }
    final start = i;
    while (i < n && !isJsSpace(s.codeUnitAt(i))) {
      i++;
    }
    if (i - start == token.length && s.startsWith(token, start)) return true;
  }
  return false;
}

final _letterOrNumber = RegExp(r'^[\p{L}\p{N}]$', unicode: true);
final _letterOrNumberCache = <int, bool>{};

/// `/[\p{L}\p{N}]/u` for one code point.
bool isLetterOrNumber(int cp) {
  if (cp < 0x80) return (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x30 && cp <= 0x39);
  return _letterOrNumberCache[cp] ??= _letterOrNumber.hasMatch(String.fromCharCode(cp));
}

/// `s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)`.
List<String> lettersAndNumbers(String s) {
  final out = <String>[];
  final n = s.length;
  var start = -1;
  var i = 0;
  while (i < n) {
    var cp = s.codeUnitAt(i);
    var width = 1;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      final low = s.codeUnitAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        width = 2;
      }
    }
    if (isLetterOrNumber(cp)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.add(s.substring(start, i));
      start = -1;
    }
    i += width;
  }
  if (start >= 0) out.add(s.substring(start));
  return out;
}
