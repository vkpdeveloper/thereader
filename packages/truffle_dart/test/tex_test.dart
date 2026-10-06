import 'dart:async';
import 'dart:isolate';

import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

// The same pages as packages/truffle/test/tex.test.ts.

/// A page that uses TeX (`\(...\)`), with [paragraph] as its second block.
Article? _page(String paragraph) {
  final prose = 'Some long prose sentence here to pass thresholds. ' * 15;
  final more = 'More prose here to make the article long enough. ' * 10;
  return extractHtml(
    '<html><head><title>Tex test page</title></head><body><article><h1>Tex test page</h1>'
        '<p>$prose</p><p>$paragraph</p><p>$more</p></article></body></html>',
    'https://example.com/a',
  );
}

Object? _second(String paragraph) => _page(paragraph)!.blocks[1].toJson();

/// [_second] in an isolate that is killed after [timeout]: a synchronous loop
/// that never ends cannot be stopped by the test's own timeout.
Future<Object?> _secondWithin(String paragraph, Duration timeout) async {
  final port = ReceivePort();
  final isolate = await Isolate.spawn((SendPort out) => out.send(_second(paragraph)), port.sendPort);
  try {
    return await port.first.timeout(timeout);
  } on TimeoutException {
    isolate.kill(priority: Isolate.immediate);
    rethrow;
  } finally {
    port.close();
  }
}

Map<String, Object?> _text(String t) => {'type': 'text', 'text': t};
Map<String, Object?> _math(String t) => {'type': 'math', 'tex': t, 'text': t};

void main() {
  test(r'a formula after text holding a $ comes out once', () {
    expect(_second(r'Costs $5, see \(x\) here'), {
      'type': 'paragraph',
      'content': [_text(r'Costs $5, see '), _math('x'), _text(' here')],
    });
  });

  // These inputs used to loop forever in TypeScript (a nested call reset the shared pattern's lastIndex).
  test(r'TeX input that used to loop forever finishes', () async {
    expect(await _secondWithin(r'one \(a\) $ \(b\) end', const Duration(seconds: 10)), {
      'type': 'paragraph',
      'content': [_text('one '), _math('a'), _text(r' $ '), _math('b'), _text(' end')],
    });
    expect(await _secondWithin(r'one \(a\) $ \(b\) and \ \(c\) end', const Duration(seconds: 10)), {
      'type': 'paragraph',
      'content': [_text('one '), _math('a'), _text(r' $ '), _math('b'), _text(r' and \ '), _math('c'), _text(' end')],
    });
  });
}
