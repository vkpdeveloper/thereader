import 'dart:convert';
import 'dart:io';
import 'package:pdf_extractor/pdf_extractor.dart';

void main() {
  Directory('test-corpus/pdf/native/dart').createSync(recursive: true);
  for (final name in [
    'harness',
    'axler',
    'hefferon',
    'thinkpython',
    'calculus',
  ]) {
    final d = extract(
      File('test-corpus/pdf/real-world/$name.pdf').readAsBytesSync(),
    );
    File(
      'test-corpus/pdf/native/dart/$name.json',
    ).writeAsStringSync(jsonEncode(d));
    stdout.writeln('$name ${jsonEncode(d.stats)}');
  }
}
