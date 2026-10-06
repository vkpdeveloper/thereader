/// URL helpers (`url.ts`) and a port of the WHATWG URL parser, so
/// `new URL(href, base).href` resolves exactly as in JavaScript.
library;

import 'dart:convert';

import 'js.dart';

final _strip = RegExp(r'[\t\n\r]');
final _unsafeScheme = RegExp(r'^(?:javascript|vbscript|about|blob):', caseSensitive: false);
final _dataScheme = RegExp(r'^data:', caseSensitive: false);
final _httpScheme = RegExp(r'^https?:\/\/', caseSensitive: false);

/// Resolves [href] against [base]. Returns null for empty, script and
/// malformed values. Whitespace inside the value is percent-encoded first so
/// both implementations agree on sloppy publisher markup.
String? resolveUrl(String href, String base) {
  final value = jsTrim(href).replaceAll(_strip, '').replaceAll(' ', '%20');
  if (value.isEmpty || _unsafeScheme.hasMatch(value)) return null;
  if (_dataScheme.hasMatch(value)) return value;
  return whatwgHref(value, base);
}

/// http(s) only.
String? resolveHttp(String href, String base) {
  final url = resolveUrl(href, base);
  return url != null && _httpScheme.hasMatch(url) ? url : null;
}

final _hostPattern = RegExp(r'^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)', caseSensitive: false);
final _www = RegExp(r'^www\.');

/// Host without `www.`.
String hostOf(String url) {
  final m = _hostPattern.firstMatch(url);
  return m == null ? '' : jsLower(m.group(1)!).replaceFirst(_www, '');
}

final _tracking = RegExp(
  r'^(?:utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|ref|ref_src|ref_url|cmpid|ocid|smid|smtyp|sr_share|igshid|_hsenc|_hsmi|mkt_tok|spm|share|source|via|guccounter|guce_referrer|guce_referrer_sig)$',
  caseSensitive: false,
);

/// The URL without its fragment and without tracking parameters, so the same
/// story saves once.
String canonicalUrl(String url) {
  final hash = url.indexOf('#');
  final noHash = hash >= 0 ? url.substring(0, hash) : url;
  final q = noHash.indexOf('?');
  if (q < 0) return noHash;
  final kept = noHash
      .substring(q + 1)
      .split('&')
      .where((pair) => pair.isNotEmpty && !_tracking.hasMatch(jsSplit(pair, '=')[0]))
      .toList();
  return kept.isNotEmpty ? '${noHash.substring(0, q)}?${kept.join('&')}' : noHash.substring(0, q);
}

// ------------------------------------------------------------------ WHATWG URL

/// `new URL(input, base).href`, or null where the constructor throws. A port
/// of the WHATWG URL Standard's basic parser for the cases web pages use:
/// special and opaque schemes, relative references, dot segments,
/// percent-encoding, IPv4 hosts, default ports and IDNA labels.
String? whatwgHref(String input, [String? base]) {
  _Url? parsedBase;
  if (base != null) {
    if (base == _lastBase) {
      parsedBase = _lastParsed;
    } else {
      parsedBase = _Url.parse(base, null);
      _lastBase = base;
      _lastParsed = parsedBase;
    }
    if (parsedBase == null) return null;
  }
  return _Url.parse(input, parsedBase)?.href;
}

// Pages resolve every URL against the same base: parse it once.
String? _lastBase;
_Url? _lastParsed;

const _defaultPorts = {'http': 80, 'https': 443, 'ws': 80, 'wss': 443, 'ftp': 21};

bool _isSpecial(String scheme) => _defaultPorts.containsKey(scheme) || scheme == 'file';

bool _isAlpha(int c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

bool _isDigit(int c) => c >= 0x30 && c <= 0x39;

class _Url {
  String scheme = '';
  String username = '';
  String password = '';
  String? host;
  int? port;
  List<String> path = [];
  String? opaquePath;
  String? query;
  String? fragment;

  bool get special => _isSpecial(scheme);

  String get href {
    final out = StringBuffer('$scheme:');
    if (host != null) {
      out.write('//');
      if (username.isNotEmpty || password.isNotEmpty) {
        out.write(username);
        if (password.isNotEmpty) out.write(':$password');
        out.write('@');
      }
      out.write(host);
      if (port != null) out.write(':$port');
    }
    if (opaquePath != null) {
      out.write(opaquePath);
    } else {
      if (host == null && path.length > 1 && path.first.isEmpty) out.write('/.');
      for (final segment in path) {
        out.write('/$segment');
      }
    }
    if (query != null) out.write('?$query');
    if (fragment != null) out.write('#$fragment');
    return out.toString();
  }

  static _Url? parse(String raw, _Url? base) {
    var input = raw.replaceAll(_strip, '');
    var start = 0;
    var end = input.length;
    while (start < end && input.codeUnitAt(start) <= 0x20) {
      start++;
    }
    while (end > start && input.codeUnitAt(end - 1) <= 0x20) {
      end--;
    }
    input = input.substring(start, end);
    final url = _Url();

    var i = 0;
    String? scheme;
    if (input.isNotEmpty && _isAlpha(input.codeUnitAt(0))) {
      var j = 1;
      while (j < input.length) {
        final c = input.codeUnitAt(j);
        if (_isAlpha(c) || _isDigit(c) || c == 0x2b || c == 0x2d || c == 0x2e) {
          j++;
        } else {
          break;
        }
      }
      if (j < input.length && input.codeUnitAt(j) == 0x3a) {
        scheme = input.substring(0, j).toLowerCase();
        i = j + 1;
      }
    }

    if (scheme != null) {
      url.scheme = scheme;
      final rest = input.substring(i);
      if (url.special) {
        if (base != null && base.scheme == scheme && !rest.startsWith('//')) return _relative(url, base, rest);
        return _authority(url, _skipSlashes(rest));
      }
      if (rest.startsWith('//')) return _authority(url, rest.substring(2));
      if (rest.startsWith('/')) {
        _parsePathQueryFragment(url, rest);
        return url;
      }
      final (pathPart, query, fragment) = _splitTail(rest);
      url.opaquePath = _encode(pathPart, _c0Set);
      url.query = query == null ? null : _encode(query, _querySet);
      url.fragment = fragment == null ? null : _encode(fragment, _fragmentSet);
      return url;
    }

    if (base == null) return null;
    if (base.opaquePath != null) {
      if (!input.startsWith('#')) return null;
      url
        ..scheme = base.scheme
        ..opaquePath = base.opaquePath
        ..query = base.query
        ..fragment = _encode(input.substring(1), _fragmentSet);
      return url;
    }
    url.scheme = base.scheme;
    return _relative(url, base, input);
  }

  static String _skipSlashes(String s) {
    var k = 0;
    while (k < s.length && (s.codeUnitAt(k) == 0x2f || s.codeUnitAt(k) == 0x5c)) {
      k++;
    }
    return s.substring(k);
  }

  static bool _isSlash(_Url url, int c) => c == 0x2f || (url.special && c == 0x5c);

  static _Url? _relative(_Url url, _Url base, String input) {
    if (input.isNotEmpty && _isSlash(url, input.codeUnitAt(0))) {
      if (input.length > 1 && _isSlash(url, input.codeUnitAt(1))) {
        return _authority(url, url.special ? _skipSlashes(input) : input.substring(2));
      }
      url
        ..username = base.username
        ..password = base.password
        ..host = base.host
        ..port = base.port;
      _parsePathQueryFragment(url, input);
      return url;
    }
    url
      ..username = base.username
      ..password = base.password
      ..host = base.host
      ..port = base.port;
    if (input.isEmpty) {
      url
        ..path = List.of(base.path)
        ..query = base.query;
      return url;
    }
    if (input.startsWith('?')) {
      url.path = List.of(base.path);
      final (_, query, fragment) = _splitTail(input);
      url.query = _encode(query!, url.special ? _specialQuerySet : _querySet);
      url.fragment = fragment == null ? null : _encode(fragment, _fragmentSet);
      return url;
    }
    if (input.startsWith('#')) {
      url
        ..path = List.of(base.path)
        ..query = base.query
        ..fragment = _encode(input.substring(1), _fragmentSet);
      return url;
    }
    url.path = List.of(base.path);
    if (url.path.isNotEmpty) url.path.removeLast();
    _parsePathQueryFragment(url, input, relative: true);
    return url;
  }

  /// Authority (userinfo, host, port), then path, query and fragment.
  static _Url? _authority(_Url url, String rest) {
    var end = 0;
    while (end < rest.length) {
      final c = rest.codeUnitAt(end);
      if (c == 0x2f || c == 0x3f || c == 0x23 || (url.special && c == 0x5c)) break;
      end++;
    }
    var authority = rest.substring(0, end);
    final at = authority.lastIndexOf('@');
    if (at >= 0) {
      final userinfo = authority.substring(0, at);
      authority = authority.substring(at + 1);
      final colon = userinfo.indexOf(':');
      url.username = _encode(colon >= 0 ? userinfo.substring(0, colon) : userinfo, _userinfoSet);
      url.password = colon >= 0 ? _encode(userinfo.substring(colon + 1), _userinfoSet) : '';
    }
    var hostPart = authority;
    String? portPart;
    if (!authority.startsWith('[')) {
      final colon = authority.lastIndexOf(':');
      if (colon >= 0) {
        hostPart = authority.substring(0, colon);
        portPart = authority.substring(colon + 1);
      }
    } else {
      final close = authority.indexOf(']');
      if (close < 0) return null;
      hostPart = authority.substring(0, close + 1);
      final after = authority.substring(close + 1);
      if (after.isNotEmpty) {
        if (!after.startsWith(':')) return null;
        portPart = after.substring(1);
      }
    }
    if (hostPart.isEmpty && url.special && url.scheme != 'file') return null;
    final host = url.special ? _parseHost(hostPart) : _opaqueHost(hostPart);
    if (host == null) return null;
    url.host = host;
    if (portPart != null && portPart.isNotEmpty) {
      if (!portPart.codeUnits.every(_isDigit)) return null;
      final port = int.tryParse(portPart);
      if (port == null || port > 65535) return null;
      url.port = _defaultPorts[url.scheme] == port ? null : port;
    }
    final tail = rest.substring(end);
    if (tail.isEmpty) {
      url.path = url.special ? [''] : [];
      return url;
    }
    _parsePathQueryFragment(url, tail);
    return url;
  }

  static (String, String?, String?) _splitTail(String s) {
    String? fragment;
    final hash = s.indexOf('#');
    var rest = s;
    if (hash >= 0) {
      fragment = s.substring(hash + 1);
      rest = s.substring(0, hash);
    }
    String? query;
    final q = rest.indexOf('?');
    if (q >= 0) {
      query = rest.substring(q + 1);
      rest = rest.substring(0, q);
    }
    return (rest, query, fragment);
  }

  static void _parsePathQueryFragment(_Url url, String s, {bool relative = false}) {
    final (pathPart, query, fragment) = _splitTail(s);
    final segments = url.special ? jsSplit(pathPart, _slashes) : jsSplit(pathPart, '/');
    var k = 0;
    if (!relative && segments.isNotEmpty && segments.first.isEmpty) k = 1;
    for (; k < segments.length; k++) {
      final segment = segments[k];
      final last = k == segments.length - 1;
      final lower = segment.toLowerCase();
      if (lower == '..' || lower == '.%2e' || lower == '%2e.' || lower == '%2e%2e') {
        if (url.path.isNotEmpty && !(url.path.length == 1 && url.scheme == 'file' && _isDriveLetter(url.path.first))) {
          url.path.removeLast();
        }
        if (last) url.path.add('');
      } else if (lower == '.' || lower == '%2e') {
        if (last) url.path.add('');
      } else {
        url.path.add(_encode(segment, _pathSet));
      }
    }
    if (url.path.isEmpty && url.special) url.path.add('');
    url.query = query == null ? null : _encode(query, url.special ? _specialQuerySet : _querySet);
    url.fragment = fragment == null ? null : _encode(fragment, _fragmentSet);
  }

  static final _slashes = RegExp(r'[/\\]');

  static bool _isDriveLetter(String s) => s.length == 2 && _isAlpha(s.codeUnitAt(0)) && (s[1] == ':' || s[1] == '|');

  static String? _opaqueHost(String input) {
    for (final c in input.codeUnits) {
      if (c != 0x25 && _forbiddenHost(c)) return null;
    }
    return _encode(input, _c0Set);
  }

  static bool _forbiddenHost(int c) =>
      c == 0x00 ||
      c == 0x09 ||
      c == 0x0a ||
      c == 0x0d ||
      c == 0x20 ||
      c == 0x23 ||
      c == 0x2f ||
      c == 0x3a ||
      c == 0x3c ||
      c == 0x3e ||
      c == 0x3f ||
      c == 0x40 ||
      c == 0x5b ||
      c == 0x5c ||
      c == 0x5d ||
      c == 0x5e ||
      c == 0x7c;

  static String? _parseHost(String input) {
    if (input.startsWith('[')) {
      if (!input.endsWith(']')) return null;
      return _ipv6(input.substring(1, input.length - 1));
    }
    String domain;
    try {
      domain = Uri.decodeComponent(input);
    } catch (_) {
      domain = input;
    }
    final ascii = _toAscii(domain);
    if (ascii == null || ascii.isEmpty) return null;
    for (final c in ascii.codeUnits) {
      if (_forbiddenHost(c) || c <= 0x1f || c == 0x25 || c == 0x7f) return null;
    }
    final labels = ascii.split('.');
    final lastLabel = labels.last.isEmpty && labels.length > 1 ? labels[labels.length - 2] : labels.last;
    if (_ipv4Number(lastLabel) != null || (lastLabel.isNotEmpty && lastLabel.codeUnits.every(_isDigit))) {
      return _ipv4(ascii);
    }
    return ascii;
  }

  static final _decimalDigits = RegExp(r'^[0-9]+$');
  static final _octalDigits = RegExp(r'^[0-7]+$');
  static final _hexDigits = RegExp(r'^[0-9a-fA-F]+$');

  static int? _ipv4Number(String s) {
    if (s.isEmpty) return null;
    var radix = 10;
    var digits = s;
    var valid = _decimalDigits;
    if (s.length >= 2 && (s.startsWith('0x') || s.startsWith('0X'))) {
      radix = 16;
      digits = s.substring(2);
      valid = _hexDigits;
    } else if (s.length >= 2 && s.startsWith('0')) {
      radix = 8;
      digits = s.substring(1);
      valid = _octalDigits;
    }
    if (digits.isEmpty) return 0;
    if (!valid.hasMatch(digits)) return null;
    return int.tryParse(digits, radix: radix) ?? (1 << 40);
  }

  static String? _ipv4(String input) {
    final parts = input.split('.');
    if (parts.last.isEmpty && parts.length > 1) parts.removeLast();
    if (parts.length > 4) return null;
    final numbers = <int>[];
    for (final part in parts) {
      final n = _ipv4Number(part);
      if (n == null) return null;
      numbers.add(n);
    }
    for (var k = 0; k < numbers.length - 1; k++) {
      if (numbers[k] > 255) return null;
    }
    if (numbers.last >= 1 << (8 * (5 - numbers.length))) return null;
    var value = numbers.last;
    for (var k = 0; k < numbers.length - 1; k++) {
      value += numbers[k] << (8 * (3 - k));
    }
    return [for (var k = 3; k >= 0; k--) (value >> (8 * k)) & 0xff].join('.');
  }

  static String? _ipv6(String input) {
    try {
      final bytes = Uri.parseIPv6Address(input);
      final pieces = [for (var k = 0; k < 16; k += 2) bytes[k] << 8 | bytes[k + 1]];
      var bestStart = -1;
      var bestLen = 1;
      for (var k = 0; k < 8;) {
        if (pieces[k] != 0) {
          k++;
          continue;
        }
        var e = k;
        while (e < 8 && pieces[e] == 0) {
          e++;
        }
        if (e - k > bestLen) {
          bestStart = k;
          bestLen = e - k;
        }
        k = e;
      }
      final out = StringBuffer('[');
      for (var k = 0; k < 8; k++) {
        if (k == bestStart) {
          out.write(k == 0 ? '::' : ':');
          k += bestLen - 1;
          continue;
        }
        out.write(pieces[k].toRadixString(16));
        if (k < 7) out.write(':');
      }
      out.write(']');
      return out.toString();
    } on FormatException {
      return null;
    }
  }

  static final _dots = RegExp('[.\u3002\uff0e\uff61]');

  /// Domain to ASCII: lowercase, with non-ASCII labels in Punycode.
  static String? _toAscii(String domain) {
    final labels = domain.toLowerCase().split(_dots);
    final out = <String>[];
    for (final label in labels) {
      if (label.codeUnits.every((c) => c < 0x80)) {
        out.add(label);
      } else {
        final encoded = _punycode(label);
        if (encoded == null) return null;
        out.add('xn--$encoded');
      }
    }
    return out.join('.');
  }

  static String? _punycode(String label) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    final input = label.runes.toList();
    final output = StringBuffer();
    for (final c in input) {
      if (c < 0x80) output.writeCharCode(c);
    }
    final basic = output.length;
    var handled = basic;
    if (basic > 0) output.write('-');
    var n = 128, delta = 0, bias = 72;
    int adapt(int delta, int points, bool first) {
      delta = first ? delta ~/ damp : delta ~/ 2;
      delta += delta ~/ points;
      var k = 0;
      while (delta > ((base - tMin) * tMax) ~/ 2) {
        delta ~/= base - tMin;
        k += base;
      }
      return k + (base - tMin + 1) * delta ~/ (delta + skew);
    }

    String digit(int d) => String.fromCharCode(d < 26 ? 0x61 + d : 0x16 + d);
    while (handled < input.length) {
      var m = 0x10ffff + 1;
      for (final c in input) {
        if (c >= n && c < m) m = c;
      }
      delta += (m - n) * (handled + 1);
      n = m;
      for (final c in input) {
        if (c < n) delta++;
        if (c == n) {
          var q = delta;
          for (var k = base; ; k += base) {
            final t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
            if (q < t) break;
            output.write(digit(t + (q - t) % (base - t)));
            q = (q - t) ~/ (base - t);
          }
          output.write(digit(q));
          bias = adapt(delta, handled + 1, handled == basic);
          delta = 0;
          handled++;
        }
      }
      delta++;
      n++;
    }
    return output.toString();
  }
}

// ------------------------------------------------------------------ percent-encoding

bool _c0Set(int c) => c < 0x20 || c > 0x7e;

bool _fragmentSet(int c) => _c0Set(c) || c == 0x20 || c == 0x22 || c == 0x3c || c == 0x3e || c == 0x60;

bool _querySet(int c) => _c0Set(c) || c == 0x20 || c == 0x22 || c == 0x23 || c == 0x3c || c == 0x3e;

bool _specialQuerySet(int c) => _querySet(c) || c == 0x27;

bool _pathSet(int c) => _querySet(c) || c == 0x3f || c == 0x5e || c == 0x60 || c == 0x7b || c == 0x7d;

bool _userinfoSet(int c) =>
    _pathSet(c) ||
    c == 0x2f ||
    c == 0x3a ||
    c == 0x3b ||
    c == 0x3d ||
    c == 0x40 ||
    (c >= 0x5b && c <= 0x5d) ||
    c == 0x7c;

const _hex = '0123456789ABCDEF';

String _encode(String s, bool Function(int c) encodeSet) {
  var plain = true;
  for (var k = 0; k < s.length; k++) {
    if (encodeSet(s.codeUnitAt(k))) {
      plain = false;
      break;
    }
  }
  if (plain) return s;
  final out = StringBuffer();
  for (final rune in s.runes) {
    if (rune < 0x80 && !encodeSet(rune)) {
      out.writeCharCode(rune);
      continue;
    }
    final scalar = rune >= 0xd800 && rune <= 0xdfff ? 0xfffd : rune;
    for (final byte in utf8.encode(String.fromCharCode(scalar))) {
      out
        ..write('%')
        ..write(_hex[byte >> 4])
        ..write(_hex[byte & 0xf]);
    }
  }
  return out.toString();
}
