package pdfextractor

import (
	_ "embed"
	"strconv"
	"strings"
	"sync"
)

// Adobe's standard glyph-name DATA, not an extraction library. The upstream
// BSD notice is retained in the embedded file and distributed with this module.
// https://github.com/adobe-type-tools/agl-aglfn (glyphlist.txt, table 2.0).
//
//go:embed data/glyphlist.txt
var adobeGlyphData string
var adobeGlyphs map[string]string
var adobeGlyphOnce sync.Once

func adobeGlyph(name string) string {
	adobeGlyphOnce.Do(func() {
		adobeGlyphs = map[string]string{}
		for _, line := range strings.Split(adobeGlyphData, "\n") {
			if strings.HasPrefix(line, "#") {
				continue
			}
			name, hex, ok := strings.Cut(line, ";")
			if !ok {
				continue
			}
			var value strings.Builder
			for _, part := range strings.Fields(hex) {
				n, e := strconv.ParseUint(part, 16, 32)
				if e == nil {
					value.WriteRune(rune(n))
				}
			}
			adobeGlyphs[name] = value.String()
		}
	})
	return adobeGlyphs[name]
}

func texGlyph(name string) string {
	// TeX delimiter variants have different outlines but the same character.
	for _, suffix := range []string{"Bigg", "bigg", "Big", "big", "display", "text"} {
		if strings.HasSuffix(name, suffix) {
			base := strings.TrimSuffix(name, suffix)
			if v := adobeGlyph(base); v != "" {
				return v
			}
			if v := glyphs[base]; v != "" {
				return v
			}
		}
	}
	return map[string]string{
		"angbracketleft": "⟨", "angbracketright": "⟩", "arrowhookleft": "↩", "arrowhookright": "↪",
		"arrowlefttophalf": "↼", "arrowleftbothalf": "↽", "arrowrighttophalf": "⇀", "arrowrightbothalf": "⇁",
		"epsilon1": "ϵ", "epsilon": "ϵ", "phi1": "ϕ", "theta1": "ϑ", "rho1": "ϱ", "sigma1": "ς",
		"vextendsingle": "|", "vextenddouble": "‖", "radicaltp": "√", "radicalvertex": "√", "radicalbt": "√",
		"unionmulti": "⊎", "unionsq": "⊔", "intersectionsq": "⊓", "negationslash": "̸",
		"arrowsoutheast": "↘", "arrowsouthwest": "↙", "mapsto": "↦", "bardbl": "‖",
		"lessorequalslant": "⩽", "greaterorequalslant": "⩾", "check": "✓", "arrowbt": "↓", "prime": "′", "star": "⋆", "slurabove": "⌢", "subsetnoteql": "⊊",
		"tie": "⁀", "vector": "⃗", "dotlessj": "ȷ", "lscript": "ℓ", "weierstrass": "℘",
	}[name]
}
