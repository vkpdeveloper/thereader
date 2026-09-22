bool get importSupported => false;
Future<String?> pickEpub() async =>
    throw UnsupportedError('Import requires a native app.');
Future<void> cleanPickedEpub(String path) async {}
Future<Map<String, dynamic>> inspectEpub(String path) async =>
    throw UnsupportedError('Import requires a native app.');
Stream<List<int>> readImportFile(String path) =>
    throw UnsupportedError('Import requires a native app.');
