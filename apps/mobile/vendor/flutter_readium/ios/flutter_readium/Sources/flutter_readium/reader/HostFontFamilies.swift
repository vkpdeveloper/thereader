import Flutter
import Foundation
import ReadiumNavigator
import ReadiumShared

// THEREADER PATCH: bundled host-app fonts declared to the EPUB navigator.
// The files are Flutter assets of the host app, located in the app bundle and
// served offline by the navigator's local web server at `assets/fonts/<file>`.
enum HostFontFamilies {
  private static let namePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,64}$")
  private static let assetPattern = try! NSRegularExpression(pattern: "^assets/fonts/[A-Za-z0-9_.-]{1,96}$")

  private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
    regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }

  /// Parses the `fontFamilies` creation param. Malformed entries and faces
  /// whose file is missing from the bundle are dropped, so a family is only
  /// declared when its files can actually be served.
  static func declarations(
    from raw: Any?,
    registrar: FlutterPluginRegistrar
  ) -> [AnyHTMLFontFamilyDeclaration] {
    guard let entries = raw as? [[String: Any]] else { return [] }
    return entries.compactMap { entry -> AnyHTMLFontFamilyDeclaration? in
      guard let name = entry["name"] as? String, matches(namePattern, name) else { return nil }
      let fallback: FontFamily = (entry["fallback"] as? String) == "sans-serif" ? .sansSerif : .serif
      let faces = (entry["faces"] as? [[String: Any]] ?? []).compactMap { face -> CSSFontFace? in
        guard
          let asset = face["asset"] as? String, matches(assetPattern, asset),
          let path = Bundle.main.path(forResource: registrar.lookupKey(forAsset: asset), ofType: nil),
          let file = FileURL(path: path, isDirectory: false)
        else {
          Log.reader.error("Missing bundled font '\(String(describing: face["asset"]))'")
          return nil
        }
        let minWeight = min(max((face["minWeight"] as? Int) ?? 400, 1), 1000)
        let maxWeight = min(max((face["maxWeight"] as? Int) ?? minWeight, minWeight), 1000)
        // Not preloaded: only the faces a chapter actually uses are fetched.
        return CSSFontFace(
          file: file,
          style: (face["style"] as? String) == "italic" ? .italic : .normal,
          weight: .variable(minWeight ... maxWeight)
        )
      }
      guard !faces.isEmpty else { return nil }
      return CSSFontFamilyDeclaration(
        fontFamily: FontFamily(rawValue: name),
        alternates: [fallback],
        fontFaces: faces
      ).eraseToAnyHTMLFontFamilyDeclaration()
    }
  }
}
