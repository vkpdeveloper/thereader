# Readium Swift 3.9.0: app-owned loopback URLs have an edition-pinned disk chunk cache.
# Avoid whole-ZIP caching and multi-megabyte read-ahead before first content.
# Normal remote URLs and local-file Minizip behavior remain unchanged.
def patch_readium_progressive_zip(pods_root)
  path = File.join(pods_root, 'ReadiumShared/Sources/Shared/Toolkit/ZIP/ZIPFoundation/ZIPFoundationArchiveFactory.swift')
  source = File.read(path)
  return if source.include?('// The Reader: bounded loopback ZIP streaming')
  changes = {
    '            let bufferSize = 6.MB' => <<~'SWIFT'.rstrip,
                // The Reader: bounded loopback ZIP streaming
                let isLoopback = resource.sourceURL?.url.scheme == "http"
                    && resource.sourceURL?.url.host == "127.0.0.1"
                let bufferSize = isLoopback ? 64.kB : 6.MB
    SWIFT
    '(!canAllocate(maximumZIPLengthToFullyCache * 2) || length > maximumZIPLengthToFullyCache)' =>
      '(isLoopback || !canAllocate(maximumZIPLengthToFullyCache * 2) || length > maximumZIPLengthToFullyCache)'
  }
  changes.each do |before, after|
    raise "Readium 3.9.0 progressive ZIP patch anchor missing: #{before}" unless source.scan(before).length == 1
    source = source.sub(before, after)
  end
  File.chmod(0644, path)
  File.write(path, source)
end
