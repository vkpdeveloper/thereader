# Readium swift-toolkit 3.9.0: repeated linear URL normalization is quadratic for
# image-heavy EPUBs. Keep an eager per-publication index, with the same depth-first
# first-match semantics. Rebuild whenever the value-type manifest is mutated.
# Fail on upstream changes rather than silently accepting an unapplied patch.
def patch_readium_href_index(pods_root)
  path = File.join(pods_root, 'ReadiumShared/Sources/Shared/Publication/Publication.swift')
  source = File.read(path)
  return if source.include?('// The Reader: indexed resource lookup')
  changes = {
    '    public var manifest: Manifest' => <<~'SWIFT'.rstrip,
    // The Reader: indexed resource lookup
    public var manifest: Manifest {
        didSet { hrefIndex = Self.makeHrefIndex(manifest) }
    }
    private var hrefIndex: [String: Link] = [:]

    private static func makeHrefIndex(_ manifest: Manifest) -> [String: Link] {
        var result: [String: Link] = [:]
        func visit(_ links: [Link]) {
            for link in links {
                let key = link.url().normalized.string
                if result[key] == nil { result[key] = link }
                visit(link.alternates)
                visit(link.children)
            }
        }
        visit(manifest.readingOrder)
        visit(manifest.resources)
        visit(manifest.links)
        return result
    }
    SWIFT
    '        self.services = services' => "        self.services = services\n        self.hrefIndex = Self.makeHrefIndex(manifest)",
    '        manifest.linkWithHREF(href)' => <<~'SWIFT'.rstrip,
        let normalized = href.anyURL.normalized
        return hrefIndex[normalized.string]
            ?? hrefIndex[normalized.removingQuery().removingFragment().string]
    SWIFT
  }
  changes.each do |before, after|
    raise "Readium 3.9.0 href patch anchor missing: #{before}" unless source.scan(before).length == 1
    source = source.sub(before, after)
  end
  File.chmod(0644, path)
  File.write(path, source)
end
