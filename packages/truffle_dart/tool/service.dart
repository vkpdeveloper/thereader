// A minimal client for the Dart VM service protocol (JSON-RPC over the
// service's WebSocket), so the profiling tools need no package dependency.
// The program must run with the service enabled:
// `dart --enable-vm-service=0 --disable-service-auth-codes tool/<tool>.dart`.
import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:io';

class ServiceClient {
  ServiceClient._(this._socket) {
    _socket.listen((message) {
      final json = jsonDecode(message as String) as Map<String, dynamic>;
      final completer = _pending.remove(json['id']);
      if (completer == null) return;
      final error = json['error'];
      if (error != null) {
        completer.completeError(StateError('VM service: ${jsonEncode(error)}'));
      } else {
        completer.complete(json['result'] as Map<String, dynamic>);
      }
    });
  }

  final WebSocket _socket;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  var _nextId = 0;

  static Future<ServiceClient> connect() async {
    final info = await Service.getInfo();
    final uri = info.serverWebSocketUri;
    if (uri == null) {
      throw StateError('Run with the VM service enabled: dart --enable-vm-service=0 --disable-service-auth-codes …');
    }
    return ServiceClient._(await WebSocket.connect(uri.toString()));
  }

  Future<Map<String, dynamic>> call(String method, [Map<String, Object?> params = const {}]) {
    final id = '${_nextId++}';
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    _socket.add(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
    return completer.future;
  }

  Future<void> close() => _socket.close();
}

/// The `test-corpus/` directory above the working directory.
String findCorpus() {
  for (var dir = Directory.current.absolute; ; dir = dir.parent) {
    final candidate = Directory('${dir.path}/test-corpus');
    if (candidate.existsSync()) return candidate.path;
    if (dir.parent.path == dir.path) throw StateError('test-corpus/ not found above ${Directory.current.path}');
  }
}
