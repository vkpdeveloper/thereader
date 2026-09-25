import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

class _Readium implements rd.FlutterReadium {
  final status = StreamController<rd.ReadiumReaderStatus>.broadcast(sync: true);
  final preferences = <rd.EPUBPreferences>[];
  @override
  Stream<rd.ReadiumReaderStatus> get onReaderStatusChanged => status.stream;
  @override
  Stream<rd.Locator> get onTextLocatorChanged => const Stream.empty();
  @override
  Stream<rd.ReadiumError> get onErrorEvent => const Stream.empty();
  @override
  Future<void> setEPUBPreferences(rd.EPUBPreferences p) async =>
      preferences.add(p);
  @override
  Future<void> applyDecorations(
    String id,
    List<rd.ReaderDecoration> decorations,
  ) async {}
  @override
  Future<void> closePublication() async {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _File implements BookFile {
  @override
  Future<void> close() async {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _Readium readium;
  late ReadiumReaderController controller;
  setUp(() {
    readium = _Readium();
    controller = ReadiumReaderController(
      readium: readium,
      publication: rd.Publication.fromJson({
        'metadata': {'title': 'Fixture'},
        'readingOrder': [
          {'href': 'chapter.xhtml', 'type': 'application/xhtml+xml'},
        ],
      })!,
      file: _File(),
      prefs: const ReaderPreferences(),
    );
  });
  tearDown(() async {
    controller.dispose();
    await readium.status.close();
  });
  test('first paint does not replay unchanged creation preferences', () {
    readium.status.add(rd.ReadiumReaderStatus.ready);
    expect(controller.pageVisible.value, isTrue);
    expect(readium.preferences, isEmpty);
  });
  test('changes during loading are coalesced and applied when ready', () {
    controller.applyPreferences(const ReaderPreferences(fontSize: 20));
    controller.applyPreferences(const ReaderPreferences(fontSize: 24));
    expect(readium.preferences, isEmpty);
    readium.status.add(rd.ReadiumReaderStatus.ready);
    expect(readium.preferences, hasLength(1));
    expect(readium.preferences.single.fontSize, 24 / 16);
    readium.status.add(rd.ReadiumReaderStatus.ready);
    expect(readium.preferences, hasLength(1));
  });
  test('live typography still applies immediately', () {
    readium.status.add(rd.ReadiumReaderStatus.ready);
    controller.applyPreferences(const ReaderPreferences(fontSize: 22));
    expect(readium.preferences.single.fontSize, 22 / 16);
  });
}
