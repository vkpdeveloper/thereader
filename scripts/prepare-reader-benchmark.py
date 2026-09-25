#!/usr/bin/env python3
"""Generate an original, shareable image-heavy EPUB (no private book content).

Usage: python3 scripts/prepare-reader-benchmark.py /tmp/reader-bench
       python3 -m http.server 8923 --bind 127.0.0.1 --directory /tmp/reader-bench
"""
import argparse
import pathlib
import struct
import zipfile
import zlib


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    # A small original plus-sign diagram, with intrinsic dimensions.
    pixels = b''.join(b'\0' + b''.join(
        bytes((32, 32, 32, 255)) if x in (14, 15, 16) or y in (6, 7, 8)
        else bytes((237, 237, 237, 255)) for x in range(32)) for y in range(16))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 32, 16, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--padding-mib', type=int, default=0, help='Stored padding before chapters for range-priority tests')
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    destination = args.directory / 'synthetic.epub'
    chapters, images = 12, 7442
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as book:
        book.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        book.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        manifest = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        for i in range(chapters):
            manifest += f'<item id="c{i}" href="Text/chapter-{i}.xhtml" media-type="application/xhtml+xml"/>'
        for i in range(images):
            manifest += f'<item id="i{i}" href="Images/{i}.png" media-type="image/png"/>'
            book.writestr(f'OEBPS/Images/{i}.png', png())
        book.writestr('OEBPS/package.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">reader-perf-fixture-v1</dc:identifier><dc:title>Reader performance fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-25T00:00:00Z</meta></metadata><manifest>' + manifest + '</manifest><spine>' + ''.join(f'<itemref idref="c{i}"/>' for i in range(chapters)) + '</spine></package>')
        book.writestr('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>' + ''.join(f'<li><a href="Text/chapter-{i}.xhtml">Chapter {i + 1}</a></li>' for i in range(chapters)) + '</ol></nav></body></html>')
        if args.padding_mib:
            # Keep the reading location physically late in the archive. Padding
            # is never referenced by a chapter and must not block a resume.
            with book.open(zipfile.ZipInfo('unused-padding.bin'), 'w') as padding:
                for _ in range(args.padding_mib):
                    padding.write(bytes(1024 * 1024))
        for chapter in range(chapters):
            # One heavy chapter near the end, plus lighter neighbors.
            count = 3072 if chapter == 9 else 100
            body = f'<h1 id="heading">Chapter {chapter + 1}</h1>'
            for i in range(count):
                body += f'<p id="p-{i}"><b>Paragraph {i + 1}.</b> This original test passage checks saved-position restoration. The inline diagram <img src="../Images/{(chapter * 613 + i) % images}.png" alt="plus sign" style="height:1em;"/> must remain visible. Nearby chapters should not delay this passage.</p>'
            book.writestr(f'OEBPS/Text/chapter-{chapter}.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Reader performance fixture</title></head><body>' + body + '</body></html>')
    print(destination)


if __name__ == '__main__':
    main()
