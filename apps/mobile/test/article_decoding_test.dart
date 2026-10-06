import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/articles/html_decoding.dart';

List<int> page(String head, List<int> body) => [...latin1.encode('<html><head>$head</head><body>'), ...body];

String bodyOf(String html) => html.substring(html.indexOf('<body>') + 6);

void main() {
  test('a byte order mark wins over every declaration', () {
    expect(decodeHtml([0xEF, 0xBB, 0xBF, ...utf8.encode('héllo')], contentType: 'text/html; charset=iso-8859-1'), 'héllo');
    expect(decodeHtml([0xFF, 0xFE, 72, 0, 105, 0]), 'Hi');
    expect(decodeHtml([0xFE, 0xFF, 0, 72, 0, 105]), 'Hi');
  });

  test('the Content-Type charset beats a meta declaration', () {
    final bytes = page('<meta charset="utf-8">', [99, 97, 102, 233]);
    expect(bodyOf(decodeHtml(bytes, contentType: 'text/html; charset="windows-1252"')), 'café');
  });

  test('meta charset and http-equiv are honoured in the first 2 KB', () {
    expect(bodyOf(decodeHtml(page('<meta charset=shift_jis>', [147, 250, 150, 123, 140, 234]))), '日本語');
    expect(
      bodyOf(decodeHtml(page('<meta http-equiv="Content-Type" content="text/html; charset=koi8-r">', [240, 210, 201, 215, 197, 212]))),
      'Привет',
    );
    final late = [...latin1.encode('<html><head>${' ' * 2100}<meta charset="windows-1251"></head><body>'), 207, 240];
    expect(decodeHtml(late).endsWith('\uFFFD\uFFFD'), isTrue, reason: 'declarations past 2 KB are ignored');
  });

  test('legacy encodings decode like a browser', () {
    final cases = {
      'windows-1252': ([99, 97, 102, 233, 32, 150, 32, 147, 113, 117, 111, 116, 101, 100, 148], 'café – “quoted”'),
      'iso-8859-1': ([99, 97, 102, 233, 32, 150], 'café –'),
      'shift_jis': ([147, 250, 150, 123, 140, 234], '日本語'),
      'euc-jp': ([198, 252, 203, 220, 184, 236], '日本語'),
      'gbk': ([214, 208, 206, 196], '中文'),
      'gb2312': ([214, 208, 206, 196], '中文'),
      'big5': ([164, 164, 164, 229], '中文'),
      'euc-kr': ([199, 209, 177, 185, 190, 238], '한국어'),
      'koi8-r': ([240, 210, 201, 215, 197, 212], 'Привет'),
      'windows-1251': ([207, 240, 232, 226, 229, 242], 'Привет'),
      'windows-1257': ([192, 254, 117, 111, 108, 97, 115], 'Ąžuolas'),
      'iso-8859-2': ([90, 97, 191, 243, 179, 230], 'Zażółć'),
      'ISO_8859-7': ([197, 235, 235, 220, 228, 225], 'Ελλάδα'),
    };
    cases.forEach((label, c) {
      expect(decodeHtml(c.$1, contentType: 'text/html; charset=$label'), c.$2, reason: label);
    });
  });

  test('unknown labels, utf-16 metas and malformed bytes fall back to UTF-8 without throwing', () {
    expect(decodeHtml(utf8.encode('ok ✓'), contentType: 'text/html; charset=x-made-up'), 'ok ✓');
    expect(bodyOf(decodeHtml(page('<meta charset="utf-16">', utf8.encode('ünïcode')))), 'ünïcode');
    expect(decodeHtml([0x61, 0xC3]), 'a\uFFFD');
    expect(() => decodeHtml([147], contentType: 'text/html; charset=shift_jis'), returnsNormally);
    expect(() => decodeHtml([198], contentType: 'text/html; charset=euc-jp'), returnsNormally);
  });

  test('charset parameters parse with quotes and spacing', () {
    expect(charsetOf('text/html;charset=UTF-8'), 'UTF-8');
    expect(charsetOf("text/html; charset = 'big5'"), 'big5');
    expect(charsetOf('text/html'), isNull);
  });
}
