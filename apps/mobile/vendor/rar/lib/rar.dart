/// Extracts a RAR 4 or RAR 5 archive into a directory, off the UI thread:
/// libarchive through FFI on a background isolate (Android), UnrarKit on a
/// background dispatch queue (iOS). Archive names never touch the file
/// system: regular file number i is written to `<destination>/i` and the
/// names are returned in that order, so links, directories and hostile paths
/// are never created.
library;

import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart';

enum RarFailure { encrypted, damaged, tooLarge, unsupported }

class RarException implements Exception {
  const RarException(this.failure, this.detail);
  final RarFailure failure;
  final String detail;
  @override
  String toString() => 'RarException(${failure.name}): $detail';
}

const _channel = MethodChannel('thereader/rar');

/// Extracts every regular file of [archivePath] into [destination], which
/// must exist and be empty, and returns the archive names: entry i is the
/// file `<destination>/i`. Fails with [RarException] when the archive is
/// encrypted, damaged or expands beyond [maxBytes].
Future<List<String>> extractRar(
  String archivePath,
  String destination, {
  required int maxBytes,
}) async {
  if (Platform.isAndroid) {
    final (code, detail) = await Isolate.run(
      () => _extractNative(archivePath, destination, maxBytes),
    );
    if (code != 0) {
      throw RarException(_failures[code] ?? RarFailure.damaged, detail);
    }
    return _index(destination);
  }
  if (Platform.isIOS) {
    try {
      await _channel.invokeMethod<void>('extract', {
        'archive': archivePath,
        'destination': destination,
        'maxBytes': maxBytes,
      });
    } on PlatformException catch (e) {
      throw RarException(
        RarFailure.values.asNameMap()[e.code] ?? RarFailure.damaged,
        e.message ?? e.code,
      );
    }
    return _index(destination);
  }
  throw const RarException(
    RarFailure.unsupported,
    'RAR extraction is available on Android and iOS only.',
  );
}

const _failures = {
  1: RarFailure.damaged,
  2: RarFailure.encrypted,
  4: RarFailure.tooLarge,
  5: RarFailure.damaged,
};

/// NUL-terminated UTF-8 names, one per extracted file, in file-number order.
Future<List<String>> _index(String destination) async {
  final bytes = await File('$destination/index').readAsBytes();
  final names = <String>[];
  var start = 0;
  for (var i = 0; i < bytes.length; i++) {
    if (bytes[i] != 0) continue;
    names.add(utf8.decode(bytes.sublist(start, i), allowMalformed: true));
    start = i + 1;
  }
  if (start != bytes.length) {
    throw const RarException(RarFailure.damaged, 'The entry index is damaged.');
  }
  return names;
}

typedef _ExtractC = Int32 Function(
  Pointer<Utf8>,
  Pointer<Utf8>,
  Int64,
  Pointer<Utf8>,
  Int32,
);
typedef _ExtractDart = int Function(
  Pointer<Utf8>,
  Pointer<Utf8>,
  int,
  Pointer<Utf8>,
  int,
);

(int, String) _extractNative(String archive, String destination, int maxBytes) {
  final extract = DynamicLibrary.open('libthereader_rar.so')
      .lookupFunction<_ExtractC, _ExtractDart>('thereader_rar_extract');
  final archivePtr = archive.toNativeUtf8();
  final destinationPtr = destination.toNativeUtf8();
  const errorLength = 512;
  final error = calloc<Uint8>(errorLength).cast<Utf8>();
  try {
    final code = extract(
      archivePtr,
      destinationPtr,
      maxBytes,
      error,
      errorLength,
    );
    return (code, error.toDartString());
  } finally {
    calloc.free(archivePtr);
    calloc.free(destinationPtr);
    calloc.free(error);
  }
}
