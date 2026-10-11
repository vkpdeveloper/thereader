# Adobe Glyph List reference data

`glyphlist.txt` is copied byte-for-byte from Adobe's AGL repository, commit
`0276763a3cdf204a1badc283d90f5bc7ac13130d`:
https://github.com/adobe-type-tools/agl-aglfn/blob/0276763a3cdf204a1badc283d90f5bc7ac13130d/glyphlist.txt

SHA-256: `a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789`.

The complete BSD 3-Clause copyright, conditions and disclaimer are retained at
the top of the file and embedded with the data in library binaries. This is a
glyph-name-to-Unicode reference table, not a parser or extraction library.
The Go PDF and font-program parsers are implemented in this package. Extra TeX
glyph aliases live separately in `glyphlist.go`.

## CFF reference tables

`cff-*.txt` contains the standard strings, Expert/ExpertSubset charsets and
StandardEncoding defined in Adobe Technical Note 5176, appendices A–C:
https://adobe-type-tools.github.io/font-tech-notes/pdfs/5176.CFF.pdf

These format tables were exported from the corresponding constants in
FontTools 4.66.1 (`cffLib` and `encodings.StandardEncoding`). The MIT license
is retained in `FONTTOOLS-LICENSE` and embedded alongside the tables. No
FontTools parsing or outline implementation is included or used at runtime.
The bounded Go charset/encoding reader is implemented in `cff_names.go`.
