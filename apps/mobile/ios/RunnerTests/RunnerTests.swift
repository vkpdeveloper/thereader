import XCTest
import ReadiumShared
import ReadiumZIPFoundation

final class RunnerTests: XCTestCase {
  func testLoopbackSmallZIPUsesBoundedReadsAndKeepsRemotePolicy() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".zip")
    defer { try? FileManager.default.removeItem(at: file) }
    let archive = try await ReadiumZIPFoundation.Archive(url: file, accessMode: .create)
    for (name, bytes) in [
      ("chapter.xhtml", Data("<p>Readable first chapter</p>".utf8)),
      ("later.bin", Data(repeating: 42, count: 2 * 1024 * 1024))
    ] {
      try await archive.addEntry(with: name, type: .file, uncompressedSize: Int64(bytes.count)) { position, count in
        bytes.subdata(in: Int(position)..<(Int(position) + count))
      }
    }
    let data = try Data(contentsOf: file)
    for loopback in [true, false] {
      let resource = CountingZIPResource(data: data, loopback: loopback)
      let asset = try await ZIPFoundationArchiveOpener().open(
        resource: resource, format: Format(specifications: .zip)
      ).get()
      let chapter = try XCTUnwrap(asset.container[AnyURL(string: "chapter.xhtml")!])
      let text = try await chapter.read().get()
      XCTAssertEqual(String(data: text, encoding: .utf8), "<p>Readable first chapter</p>")
      let read = await resource.bytesRead
      if loopback {
        XCTAssertLessThan(read, data.count / 5, "Loopback ZIP must not be cached in full")
      } else {
        XCTAssertGreaterThanOrEqual(read, data.count, "Ordinary HTTP keeps the upstream cache policy")
      }
      asset.close()
    }
  }

  func testIndexedLookupPreservesManifestSemantics() {
    let duplicate = Link(href: "image.png", title: "first")
    let root = Link(href: "chapter.xhtml", title: "root", alternates: [duplicate],
                    children: [Link(href: "image.png", title: "child duplicate")])
    let manifest = Manifest(readingOrder: [root], resources: [
      Link(href: "image.png", title: "resource duplicate"),
      Link(href: "chapter.xhtml#exact", title: "exact fragment"),
      Link(href: "folder/../normalized.png", title: "normalized")
    ])
    let publication = Publication(manifest: manifest)
    for href in ["image.png", "chapter.xhtml", "chapter.xhtml#exact",
                 "chapter.xhtml?q=1#anchor", "normalized.png", "missing"] {
      let url = AnyURL(string: href)!
      XCTAssertEqual(publication.linkWithHREF(url), manifest.linkWithHREF(url), href)
    }
    XCTAssertEqual(publication.linkWithHREF(AnyURL(string: "image.png")!)?.title, "first")
    XCTAssertEqual(publication.linkWithHREF(AnyURL(string: "chapter.xhtml#exact")!)?.title, "exact fragment")
    publication.manifest.readingOrder.insert(Link(href: "image.png", title: "new first"), at: 0)
    XCTAssertEqual(publication.linkWithHREF(AnyURL(string: "image.png")!)?.title, "new first")
    publication.manifest.resources.append(Link(href: "new.png", title: "new resource"))
    XCTAssertEqual(publication.linkWithHREF(AnyURL(string: "new.png")!)?.title, "new resource")
    publication.close()
  }
  func testLookupHotspotBenchmark() {
    let resources = (0..<7442).map { Link(href: "Images/formula-\($0).png", title: "\($0)") }
    let manifest = Manifest(resources: resources)
    let buildStart = CFAbsoluteTimeGetCurrent()
    let publication = Publication(manifest: manifest)
    let buildMs = (CFAbsoluteTimeGetCurrent() - buildStart) * 1000
    let queries = stride(from: 0, to: 7442, by: 75).map { AnyURL(string: "Images/formula-\($0).png")! }
    let before = CFAbsoluteTimeGetCurrent()
    let expected = queries.map { manifest.linkWithHREF($0) }
    let baselineMs = (CFAbsoluteTimeGetCurrent() - before) * 1000
    let after = CFAbsoluteTimeGetCurrent()
    let actual = queries.map { publication.linkWithHREF($0) }
    let indexedMs = (CFAbsoluteTimeGetCurrent() - after) * 1000
    XCTAssertEqual(actual, expected)
    print("LOOKUP_BENCH resources=7442 queries=\(queries.count) build_ms=\(buildMs) linear_ms=\(baselineMs) indexed_ms=\(indexedMs)")
    publication.close()
  }

}

private actor CountingZIPResource: Resource {
  nonisolated let sourceURL: AbsoluteURL?
  let data: Data
  var bytesRead = 0

  init(data: Data, loopback: Bool) {
    self.data = data
    sourceURL = AnyURL(string: loopback
      ? "http://127.0.0.1:12345/lease/book.epub"
      : "https://example.com/book.epub")!.absoluteURL
  }
  func estimatedLength() async -> ReadResult<UInt64?> { .success(UInt64(data.count)) }
  func properties() async -> ReadResult<ResourceProperties> { .success(ResourceProperties()) }
  func stream(range: Range<UInt64>?, consume: @escaping (Data) -> Void) async -> ReadResult<Void> {
    let lower = min(Int(range?.lowerBound ?? 0), data.count)
    let upper = min(Int(range?.upperBound ?? UInt64(data.count)), data.count)
    let chunk = data.subdata(in: lower..<upper)
    bytesRead += chunk.count
    consume(chunk)
    return .success(())
  }
}
