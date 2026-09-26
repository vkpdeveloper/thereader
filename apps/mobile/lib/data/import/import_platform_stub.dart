bool get importSupported => false;
Future<String?> pickBook() async =>
    throw UnsupportedError('Import requires a native app.');
Future<void> cleanPickedBook(String path) async {}
Future<String> prepareBook(String path) async =>
    throw UnsupportedError('Import requires a native app.');
Future<void> cleanPreparedBook(String sourcePath, String preparedPath) async {}
Future<Map<String, dynamic>> inspectEpub(String path) async =>
    throw UnsupportedError('Import requires a native app.');
Stream<List<int>> readImportFile(String path) =>
    throw UnsupportedError('Import requires a native app.');
