import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var openChannel: FlutterMethodChannel?
  private var pendingBooks: [[String: String]] = []
  private let copyQueue = DispatchQueue(label: "thereader.openEpub", qos: .userInitiated)

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let channel = FlutterMethodChannel(
      name: "thereader/open_epub",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    openChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "getPending" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(self?.pendingBooks ?? [])
      self?.pendingBooks.removeAll()
    }
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard url.isFileURL else { return super.application(app, open: url, options: options) }
    acceptEpub(url)
    return true
  }

  func acceptEpub(_ url: URL) {
    guard url.isFileURL, url.pathExtension.lowercased() == "epub" else { return }
    copyQueue.async { [weak self] in
      let item: [String: String]
      do {
        item = ["path": try Self.copyEpub(url)]
      } catch {
        item = ["error": "Could not open this EPUB from Files."]
      }
      DispatchQueue.main.async {
        self?.pendingBooks.append(item)
        self?.openChannel?.invokeMethod("filesReady", arguments: nil)
      }
    }
  }

  private static func copyEpub(_ url: URL) throws -> String {
    let accessible = url.startAccessingSecurityScopedResource()
    defer { if accessible { url.stopAccessingSecurityScopedResource() } }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("external-epub-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent("book.epub")
    do {
      var coordinationError: NSError?
      var copyError: Error?
      NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { source in
        do {
          guard let input = InputStream(url: source),
                let output = OutputStream(url: target, append: false) else {
            throw CocoaError(.fileReadUnknown)
          }
          input.open()
          output.open()
          defer { input.close(); output.close() }
          let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024)
          defer { buffer.deallocate() }
          var count = 0
          while true {
            let read = input.read(buffer, maxLength: 64 * 1024)
            if read < 0 { throw input.streamError ?? CocoaError(.fileReadUnknown) }
            if read == 0 { break }
            count += read
            if count > 512 * 1024 * 1024 { throw CocoaError(.fileReadTooLarge) }
            var written = 0
            while written < read {
              let n = output.write(buffer.advanced(by: written), maxLength: read - written)
              if n <= 0 { throw output.streamError ?? CocoaError(.fileWriteUnknown) }
              written += n
            }
          }
        } catch {
          copyError = error
        }
      }
      if let error = coordinationError { throw error }
      if let error = copyError { throw error }
      return target.path
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
