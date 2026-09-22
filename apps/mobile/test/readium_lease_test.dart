import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late rd.FlutterReadiumPlatform previous;
  late _Platform platform;
  setUp(() {
    previous = rd.FlutterReadiumPlatform.instance;
    platform = _Platform();
    rd.FlutterReadiumPlatform.instance = platform;
  });
  tearDown(() => rd.FlutterReadiumPlatform.instance = previous);

  test('provisional lease survives open and releases only after native close', () async {
    final file = _Lease();
    final controller = await const ReadiumReaderEngine().open(file: file, prefs: const ReaderPreferences());
    expect(platform.opened, file.path);
    expect(file.closes, 0);
    controller.dispose();
    controller.dispose();
    expect(platform.closes, 1);
    expect(file.closes, 0);
    platform.closing.complete();
    await Future<void>.delayed(Duration.zero);
    expect(file.closes, 1);
  });

  test('next publication waits for lease release as well as native shutdown', () async {
    final file = _Lease(delayedRelease: true);
    final engine = const ReadiumReaderEngine();
    final controller = await engine.open(file: file, prefs: const ReaderPreferences());
    controller.dispose();
    final nextFile = _Lease();
    final next = engine.open(file: nextFile, prefs: const ReaderPreferences());
    platform.closing.complete();
    await Future<void>.delayed(Duration.zero);
    expect(platform.opens, 1);
    file.release.complete();
    final nextController = await next;
    expect(platform.opens, 2);
    platform.closing = Completer<void>()..complete();
    nextController.dispose();
    await Future<void>.delayed(Duration.zero);
    expect(nextFile.closes, 1);
  });

  test('failed opening and failed native close still release the lease', () async {
    platform.failOpen = true;
    final file = _Lease();
    final opening = const ReadiumReaderEngine().open(file: file, prefs: const ReaderPreferences());
    final failure = expectLater(opening, throwsA(isA<rd.ReadiumException>()));
    await Future<void>.delayed(Duration.zero);
    expect(file.closes, 0);
    platform.closing.completeError(StateError('native teardown failed'));
    await failure;
    expect(file.closes, 1);
    platform.failOpen = false;
    platform.closing = Completer<void>()..complete();
    final controller = await const ReadiumReaderEngine().open(file: _Lease(), prefs: const ReaderPreferences());
    controller.dispose();
    await Future<void>.delayed(Duration.zero);
  });
}

class _Platform extends rd.FlutterReadiumPlatform {
  Completer<void> closing = Completer<void>();
  int closes = 0;
  int opens = 0;
  String? opened;
  bool failOpen = false;
  @override
  Future<rd.Publication> openPublication(String pubUrl) async {
    opens++;
    opened = pubUrl;
    if (failOpen) throw StateError('could not open');
    return rd.Publication.fromJson({'metadata': {'title': 'Test'}})!;
  }
  @override
  Future<void> closePublication() { closes++; return closing.future; }
  @override
  Stream<rd.Locator> get onTextLocatorChanged => const Stream.empty();
  @override
  Stream<rd.ReadiumError> get onErrorEvent => const Stream.empty();
  @override
  Stream<rd.ReadiumReaderStatus> get onReaderStatusChanged => const Stream.empty();
}

class _Lease implements ProvisionalBookFile {
  _Lease({this.delayedRelease = false});
  final bool delayedRelease;
  final release = Completer<void>();
  int closes = 0;
  @override
  int get length => 1000;
  @override
  String get path => 'http://127.0.0.1:41234/opaque/session.epub';
  @override
  Future<void> close() async { closes++; if (delayedRelease) await release.future; }
  @override
  Future<Uint8List> readAll() => throw UnimplementedError();
  @override
  Future<Uint8List> readRange(int start, int end) => throw UnimplementedError();
}
