// RAR extraction for The Reader's comic import (iOS, UnrarKit).
// Adapted from rar 0.3.0 (MIT, see LICENSE). Local changes: extraction runs on
// a background queue (the platform thread is Flutter's UI thread). Archive
// names never touch the file system: regular file number i is streamed to
// `<destination>/i` and its UTF-8 name appended, NUL-terminated, to
// `<destination>/index`, so links and directories are never created.
// Encrypted archives and archives expanding beyond a byte limit are refused.
import Flutter
import UIKit
import UnrarKit

/// unrar's ERAR_BAD_PASSWORD, which URKErrorCode does not name.
private let unrarBadPassword = 24

public class RarPlugin: NSObject, FlutterPlugin {
  private let queue = DispatchQueue(label: "thereader.rar", qos: .userInitiated)

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "thereader/rar", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(RarPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard call.method == "extract",
          let args = call.arguments as? [String: Any],
          let archive = args["archive"] as? String,
          let destination = args["destination"] as? String,
          let maxBytes = (args["maxBytes"] as? NSNumber)?.int64Value else {
      result(FlutterMethodNotImplemented)
      return
    }
    queue.async {
      let outcome: FlutterError?
      do {
        try Self.extract(archive: archive, destination: destination, maxBytes: maxBytes)
        outcome = nil
      } catch let error as RarError {
        outcome = FlutterError(code: error.code, message: error.message, details: nil)
      } catch {
        outcome = FlutterError(code: "damaged", message: error.localizedDescription, details: nil)
      }
      DispatchQueue.main.async { result(outcome) }
    }
  }

  private struct RarError: Error {
    let code: String
    let message: String
  }

  private static func extract(archive path: String, destination: String, maxBytes: Int64) throws {
    let archive: URKArchive
    do {
      archive = try URKArchive(path: path)
    } catch {
      throw RarError(code: "damaged", message: error.localizedDescription)
    }
    if archive.isPasswordProtected() {
      throw RarError(code: "encrypted", message: "The archive is encrypted.")
    }
    let infos: [URKFileInfo]
    do {
      infos = try archive.listFileInfo()
    } catch let error as NSError {
      if error.code == URKErrorCode.missingPassword.rawValue || error.code == unrarBadPassword {
        throw RarError(code: "encrypted", message: "The archive is encrypted.")
      }
      throw RarError(code: "damaged", message: error.localizedDescription)
    }
    if infos.count > 100_000 {
      throw RarError(code: "tooLarge", message: "Too many entries.")
    }
    var total: Int64 = 0
    var files: [URKFileInfo] = []
    for info in infos {
      if info.isEncryptedWithPassword {
        throw RarError(code: "encrypted", message: "The archive is encrypted.")
      }
      if info.isDirectory { continue }
      total += info.uncompressedSize
      if total > maxBytes {
        throw RarError(code: "tooLarge", message: "The archive expands beyond the size limit.")
      }
      files.append(info)
    }
    let root = URL(fileURLWithPath: destination, isDirectory: true)
    var index = Data()
    var written: Int64 = 0
    for (number, info) in files.enumerated() {
      index.append(contentsOf: Array(info.filename.utf8))
      index.append(0)
      let target = root.appendingPathComponent(String(number))
      guard FileManager.default.createFile(atPath: target.path, contents: nil),
            let handle = FileHandle(forWritingAtPath: target.path) else {
        throw RarError(code: "damaged", message: "Could not write a file.")
      }
      defer { try? handle.close() }
      var failure: Error?
      do {
        try archive.extractBufferedData(fromFile: info.filename) { chunk, _ in
          if failure != nil { return }
          written += Int64(chunk.count)
          if written > maxBytes {
            failure = RarError(code: "tooLarge", message: "The archive expands beyond the size limit.")
            return
          }
          handle.write(chunk)
        }
      } catch let error as NSError {
        if error.code == URKErrorCode.missingPassword.rawValue || error.code == unrarBadPassword {
          throw RarError(code: "encrypted", message: "The archive is encrypted.")
        }
        throw RarError(code: "damaged", message: error.localizedDescription)
      }
      if let failure = failure { throw failure }
    }
    do {
      try index.write(to: root.appendingPathComponent("index"), options: .withoutOverwriting)
    } catch {
      throw RarError(code: "damaged", message: "Could not write the index.")
    }
  }
}
