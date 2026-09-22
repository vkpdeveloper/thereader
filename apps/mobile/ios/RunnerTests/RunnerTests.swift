import XCTest
import ReadiumShared

final class RunnerTests: XCTestCase {
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
