import 'dart:convert';
import 'dart:io';
import 'package:pdf_extractor/pdf_extractor.dart';

void main(List<String> args) {
  if (args.length != 2) {
    stderr.writeln('Usage: dart run tool/extract.dart input.pdf output.json');
    exitCode = 64;
    return;
  }
  final doc = extract(File(args[0]).readAsBytesSync());
  File(args[1]).writeAsStringSync(jsonEncode(doc));
  stdout.writeln(jsonEncode(doc.stats));
}
