# Local RAR extractor

Source: rar 0.3.0 from pub.dev (MIT, see LICENSE), trimmed to what comic
import needs (docs/comics.md): extract a RAR 4 / RAR 5 archive on Android and
iOS. The upstream web, macOS, Linux and Windows code, the 1.1 MB of web assets
it declared as Flutter assets, and the unused junrar method channel are gone.

Local changes:
- One call, `extractRar(archive, destination, maxBytes:)`, returning the entry
  names. Regular file number i is written to `<destination>/i`; names go to a
  NUL-separated `<destination>/index`. Archive names never touch the file
  system, so `..`, absolute paths, links, case collisions and duplicates cannot
  write outside the destination (upstream used `archive_write_disk` without the
  `SECURE_*` flags on Android).
- Android is an FFI plugin (`src/thereader_rar.c`) built with libarchive 3.8.9,
  pinned by SHA-256 in `android/CMakeLists.txt`, RAR readers only, no crypto or
  compression dependencies. It runs in `Isolate.run`.
- iOS uses UnrarKit (CocoaPods) on a background dispatch queue. Upstream ran
  extraction on the platform thread, which Flutter merges with the UI thread.
- Encrypted archives (header or file encryption) and archives that expand past
  `maxBytes` fail with typed `RarException`s.
