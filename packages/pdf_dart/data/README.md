# Font reference data

`glyphlist.txt` is Adobe Glyph List reference data from commit
`0276763a3cdf204a1badc283d90f5bc7ac13130d`:
https://github.com/adobe-type-tools/agl-aglfn/blob/0276763a3cdf204a1badc283d90f5bc7ac13130d/glyphlist.txt

SHA-256: `a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789`.
Its complete BSD license is retained in the reference file. The source glyph
constants also contain the TeX aliases and overrides used by the Go package.

CFF standard strings, charsets and encodings are format reference tables
from Adobe Technical Note 5176 (appendices A–C), exported originally through
FontTools 4.66.1. `FONTTOOLS-LICENSE` retains the MIT license. The font parsing
and outline implementation is original code in this package. No FontTools
or other PDF extraction implementation runs in either browser engine.
