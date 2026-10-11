part of pdf_extractor;

final _pdfNumberPattern = RegExp(
  r'^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$',
);
final _pdfNameEscapePattern = RegExp(r'#([\da-f]{2})', caseSensitive: false);

typedef _Dict = Map<String, Object?>;

class _Name {
  final String value;
  const _Name(this.value);
}

class _Literal {
  final Uint8List bytes;
  const _Literal(this.bytes);
}

class _Keyword {
  final String value;
  const _Keyword(this.value);
}

class _Ref {
  final int id, gen;
  const _Ref(this.id, this.gen);
  @override
  bool operator ==(Object other) =>
      other is _Ref && other.id == id && other.gen == gen;
  @override
  int get hashCode => Object.hash(id, gen);
}

class _Stream {
  final _Dict dict;
  final Uint8List raw;
  _Stream(this.dict, this.raw);
}

bool _white(int b) =>
    b == 0 || b == 9 || b == 10 || b == 12 || b == 13 || b == 32;
bool _delimiter(int b) =>
    _white(b) || const [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].contains(b);
double _number(Object? v) => v is num ? v.toDouble() : 0;
int _integer(Object? v) => v is num ? v.truncate() : 0;
String _named(Object? v) => v is _Name ? v.value : '';
_Dict _asDict(Object? v) => v is _Stream
    ? v.dict
    : v is _Dict
    ? v
    : <String, Object?>{};
List<Object?> _asArray(Object? v) => v is List<Object?> ? v : [];
Uint8List _slice(Uint8List b, int start, [int? end]) =>
    Uint8List.sublistView(b, start, end);
String _binary(List<int> b) => String.fromCharCodes(b);
Uint8List _hexDecode(String s) {
  if (s.length.isOdd ||
      !RegExp(r'^[\da-f]*$', caseSensitive: false).hasMatch(s))
    _invalid('Invalid hexadecimal string');
  return Uint8List.fromList([
    for (var i = 0; i < s.length; i += 2)
      int.parse(s.substring(i, i + 2), radix: 16),
  ]);
}

int _intWord(String s) {
  if (!RegExp(r'^[+-]?\d+$').hasMatch(s)) _invalid('Invalid integer');
  final n = int.tryParse(s);
  if (n == null || n.abs() > 9007199254740991) _invalid('Invalid integer');
  return n;
}

class _Lexer {
  final Uint8List data;
  int pos, nodes = 0;
  _Lexer(this.data, [this.pos = 0]);
  int at(int n) => n >= 0 && n < data.length ? data[n] : -1;
  Never fail(String message) => _invalid('$message at byte $pos');
  void skip() {
    while (pos < data.length) {
      if (_white(data[pos])) {
        pos++;
        continue;
      }
      if (data[pos] == 37) {
        while (pos < data.length && data[pos] != 10 && data[pos] != 13) pos++;
        continue;
      }
      break;
    }
  }

  String word() {
    skip();
    final start = pos;
    while (pos < data.length && !_delimiter(data[pos])) pos++;
    return String.fromCharCodes(data, start, pos);
  }

  Object? value([int depth = 0]) {
    if (depth > 64 || ++nodes > 2000000) _limit();
    skip();
    if (pos >= data.length) fail('Unexpected EOF');
    switch (data[pos]) {
      case 47:
        final start = ++pos;
        while (pos < data.length && !_delimiter(data[pos])) pos++;
        return _Name(
          String.fromCharCodes(data, start, pos).replaceAllMapped(
            _pdfNameEscapePattern,
            (m) => String.fromCharCode(int.parse(m[1]!, radix: 16)),
          ),
        );
      case 40:
        pos++;
        var nesting = 1;
        final out = <int>[];
        while (pos < data.length) {
          var c = data[pos++];
          if (c == 92) {
            if (pos == data.length) break;
            c = data[pos++];
            const escapes = {110: 10, 114: 13, 116: 9, 98: 8, 102: 12};
            if (escapes.containsKey(c)) {
              c = escapes[c]!;
            } else if (c == 13 || c == 10) {
              if (c == 13 && at(pos) == 10) pos++;
              continue;
            } else if (c >= 48 && c <= 55) {
              var v = c - 48;
              for (var j = 0; j < 2 && at(pos) >= 48 && at(pos) <= 55; j++)
                v = v * 8 + data[pos++] - 48;
              c = v & 255;
            }
          } else if (c == 40) {
            if (++nesting > 64) _limit();
          } else if (c == 41) {
            if (--nesting == 0) return _Literal(Uint8List.fromList(out));
          } else if (c == 13) {
            if (at(pos) == 10) pos++;
            c = 10;
          }
          out.add(c);
        }
        return fail('Unterminated string');
      case 60:
        pos++;
        if (at(pos) == 60) {
          pos++;
          final dict = <String, Object?>{};
          var count = 0;
          while (true) {
            skip();
            if (at(pos) == 62 && at(pos + 1) == 62) {
              pos += 2;
              return dict;
            }
            final k = value(depth + 1);
            if (k is! _Name) fail('Dictionary key is not a name');
            if (!dict.containsKey(k.value) && ++count > 50000) _limit();
            dict[k.value] = value(depth + 1);
          }
        }
        final h = StringBuffer();
        while (pos < data.length && data[pos] != 62) {
          if (!_white(data[pos])) h.writeCharCode(data[pos]);
          pos++;
        }
        if (pos == data.length) fail('Unterminated hex string');
        pos++;
        var s = h.toString();
        if (s.length.isOdd) s += '0';
        return _Literal(_hexDecode(s));
      case 91:
        pos++;
        final a = <Object?>[];
        while (true) {
          skip();
          if (at(pos) == 93) {
            pos++;
            return a;
          }
          a.add(value(depth + 1));
          if (a.length > 200000) _limit();
        }
      default:
        final w = word();
        if (w.isEmpty) fail('Unexpected delimiter');
        if (w == 'true') return true;
        if (w == 'false') return false;
        if (w == 'null') return null;
        if (_pdfNumberPattern.hasMatch(w)) {
          final v = double.parse(w);
          if (!v.isFinite || v.abs() > 1e15) fail('Invalid number');
          if (v >= 0 && v == v.truncateToDouble()) {
            final saved = pos, w2 = word(), g = int.tryParse(w2);
            if (g != null && g >= 0 && g <= 65535 && word() == 'R')
              return _Ref(v.toInt(), g);
            pos = saved;
          }
          return v;
        }
        return _Keyword(w);
    }
  }
}
