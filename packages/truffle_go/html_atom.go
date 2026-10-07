package truffle

// Interned names for the HTML parser. Every tag and attribute name the parser
// sees is looked up here: a known name becomes a small integer (tree
// construction compares integers, not strings) and a static string, so
// tokenizing allocates nothing for it, whatever its case in the source.

// atom is an interned name: an index into atomNames. 0 means "not interned".
type atom uint16

const (
	aNone atom = iota
	aA
	aAbbr
	aAcronym
	aAddress
	aApplet
	aArea
	aArticle
	aAside
	aAudio
	aB
	aBase
	aBasefont
	aBdi
	aBdo
	aBgsound
	aBig
	aBlink
	aBlockquote
	aBody
	aBr
	aButton
	aCanvas
	aCaption
	aCenter
	aCite
	aCode
	aCol
	aColgroup
	aData
	aDatalist
	aDd
	aDel
	aDetails
	aDfn
	aDialog
	aDir
	aDiv
	aDl
	aDt
	aEm
	aEmbed
	aFieldset
	aFigcaption
	aFigure
	aFont
	aFooter
	aForm
	aFrame
	aFrameset
	aH1
	aH2
	aH3
	aH4
	aH5
	aH6
	aHead
	aHeader
	aHgroup
	aHr
	aHtml
	aI
	aIframe
	aImage
	aImg
	aInput
	aIns
	aIsindex
	aKbd
	aKeygen
	aLabel
	aLegend
	aLi
	aLink
	aListing
	aMain
	aMap
	aMark
	aMarquee
	aMath
	aMenu
	aMenuitem
	aMeta
	aMeter
	aNav
	aNobr
	aNoembed
	aNoframes
	aNoscript
	aObject
	aOl
	aOptgroup
	aOption
	aOutput
	aP
	aParam
	aPicture
	aPlaintext
	aPortal
	aPre
	aProgress
	aQ
	aRb
	aRp
	aRt
	aRtc
	aRuby
	aS
	aSamp
	aScript
	aSearch
	aSection
	aSelect
	aSelectedcontent
	aSlot
	aSmall
	aSource
	aSpan
	aStrike
	aStrong
	aStyle
	aSub
	aSummary
	aSup
	aSvg
	aTable
	aTbody
	aTd
	aTemplate
	aTextarea
	aTfoot
	aTh
	aThead
	aTime
	aTitle
	aTr
	aTrack
	aTt
	aU
	aUl
	aVar
	aVideo
	aWbr
	aXmp
	aDesc
	aMi
	aMo
	aMn
	aMs
	aMtext
	aMglyph
	aMalignmark
	aAnnotationXml
	aForeignObject
)

// atomNames holds every interned name; the named atoms come first.
var atomNames = [...]string{
	aA:               "a",
	aAbbr:            "abbr",
	aAcronym:         "acronym",
	aAddress:         "address",
	aApplet:          "applet",
	aArea:            "area",
	aArticle:         "article",
	aAside:           "aside",
	aAudio:           "audio",
	aB:               "b",
	aBase:            "base",
	aBasefont:        "basefont",
	aBdi:             "bdi",
	aBdo:             "bdo",
	aBgsound:         "bgsound",
	aBig:             "big",
	aBlink:           "blink",
	aBlockquote:      "blockquote",
	aBody:            "body",
	aBr:              "br",
	aButton:          "button",
	aCanvas:          "canvas",
	aCaption:         "caption",
	aCenter:          "center",
	aCite:            "cite",
	aCode:            "code",
	aCol:             "col",
	aColgroup:        "colgroup",
	aData:            "data",
	aDatalist:        "datalist",
	aDd:              "dd",
	aDel:             "del",
	aDetails:         "details",
	aDfn:             "dfn",
	aDialog:          "dialog",
	aDir:             "dir",
	aDiv:             "div",
	aDl:              "dl",
	aDt:              "dt",
	aEm:              "em",
	aEmbed:           "embed",
	aFieldset:        "fieldset",
	aFigcaption:      "figcaption",
	aFigure:          "figure",
	aFont:            "font",
	aFooter:          "footer",
	aForm:            "form",
	aFrame:           "frame",
	aFrameset:        "frameset",
	aH1:              "h1",
	aH2:              "h2",
	aH3:              "h3",
	aH4:              "h4",
	aH5:              "h5",
	aH6:              "h6",
	aHead:            "head",
	aHeader:          "header",
	aHgroup:          "hgroup",
	aHr:              "hr",
	aHtml:            "html",
	aI:               "i",
	aIframe:          "iframe",
	aImage:           "image",
	aImg:             "img",
	aInput:           "input",
	aIns:             "ins",
	aIsindex:         "isindex",
	aKbd:             "kbd",
	aKeygen:          "keygen",
	aLabel:           "label",
	aLegend:          "legend",
	aLi:              "li",
	aLink:            "link",
	aListing:         "listing",
	aMain:            "main",
	aMap:             "map",
	aMark:            "mark",
	aMarquee:         "marquee",
	aMath:            "math",
	aMenu:            "menu",
	aMenuitem:        "menuitem",
	aMeta:            "meta",
	aMeter:           "meter",
	aNav:             "nav",
	aNobr:            "nobr",
	aNoembed:         "noembed",
	aNoframes:        "noframes",
	aNoscript:        "noscript",
	aObject:          "object",
	aOl:              "ol",
	aOptgroup:        "optgroup",
	aOption:          "option",
	aOutput:          "output",
	aP:               "p",
	aParam:           "param",
	aPicture:         "picture",
	aPlaintext:       "plaintext",
	aPortal:          "portal",
	aPre:             "pre",
	aProgress:        "progress",
	aQ:               "q",
	aRb:              "rb",
	aRp:              "rp",
	aRt:              "rt",
	aRtc:             "rtc",
	aRuby:            "ruby",
	aS:               "s",
	aSamp:            "samp",
	aScript:          "script",
	aSearch:          "search",
	aSection:         "section",
	aSelect:          "select",
	aSelectedcontent: "selectedcontent",
	aSlot:            "slot",
	aSmall:           "small",
	aSource:          "source",
	aSpan:            "span",
	aStrike:          "strike",
	aStrong:          "strong",
	aStyle:           "style",
	aSub:             "sub",
	aSummary:         "summary",
	aSup:             "sup",
	aSvg:             "svg",
	aTable:           "table",
	aTbody:           "tbody",
	aTd:              "td",
	aTemplate:        "template",
	aTextarea:        "textarea",
	aTfoot:           "tfoot",
	aTh:              "th",
	aThead:           "thead",
	aTime:            "time",
	aTitle:           "title",
	aTr:              "tr",
	aTrack:           "track",
	aTt:              "tt",
	aU:               "u",
	aUl:              "ul",
	aVar:             "var",
	aVideo:           "video",
	aWbr:             "wbr",
	aXmp:             "xmp",
	aDesc:            "desc",
	aMi:              "mi",
	aMo:              "mo",
	aMn:              "mn",
	aMs:              "ms",
	aMtext:           "mtext",
	aMglyph:          "mglyph",
	aMalignmark:      "malignmark",
	aAnnotationXml:   "annotation-xml",
	aForeignObject:   "foreignObject",
	"g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "use",
	"symbol", "stop", "mask", "pattern", "filter", "marker", "animate", "set", "metadata", "view", "switch",
	"annotation", "semantics", "mrow", "mfrac", "msup", "msub", "msubsup", "msqrt", "mroot", "mstyle", "mspace",
	"mtable", "mtr", "mtd", "munder", "mover", "munderover", "mpadded", "mphantom", "menclose", "merror",
	"mmultiscripts", "mprescripts", "none", "maction", "mlabeledtr", "id", "class", "href", "src", "alt",
	"type", "name", "content", "rel", "lang", "width", "height", "value", "charset", "property", "itemprop",
	"itemscope", "itemtype", "itemid", "target", "role", "hidden", "srcset", "sizes", "loading", "decoding",
	"crossorigin", "integrity", "async", "defer", "media", "for", "action", "method", "colspan", "rowspan",
	"border", "cellpadding", "cellspacing", "align", "valign", "bgcolor", "color", "face", "size", "tabindex",
	"xmlns", "xlink:href", "xlink:title", "xlink:actuate", "xlink:arcrole", "xlink:role", "xlink:show",
	"xlink:type", "xml:lang", "xml:space", "xml:base", "xmlns:xlink", "fill", "stroke", "d", "encoding",
	"aria-hidden", "aria-label", "aria-labelledby", "aria-describedby", "aria-expanded", "aria-controls",
	"aria-current", "aria-haspopup", "aria-live", "aria-level", "data-src", "data-srcset", "onclick", "onload",
	"onerror", "http-equiv", "datetime", "placeholder", "autocomplete", "disabled", "checked", "selected",
	"readonly", "required", "multiple", "maxlength", "accept", "enctype", "novalidate", "frameborder",
	"allowfullscreen", "allow", "sandbox", "poster", "controls", "autoplay", "muted", "loop", "playsinline",
	"preload", "kind", "srclang", "start", "reversed", "nonce", "referrerpolicy", "as", "fetchpriority",
	"translate", "spellcheck", "contenteditable", "draggable", "accesskey", "download", "ping", "hreflang",
	"shape", "coords", "usemap", "ismap", "scope", "headers", "clear", "nowrap", "noshade", "stroke-width",
	"stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-opacity", "fill-rule",
	"fill-opacity", "clip-rule", "transform", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
	"points", "offset", "stop-color", "stop-opacity", "opacity", "version", "focusable", "xmlns:svg",
	"mathvariant", "display", "displaystyle", "stretchy", "fence", "separator", "lspace", "rspace", "mathcolor",
	"mathsize", "columnalign", "rowspacing", "columnspacing", "scriptlevel", "accent", "accentunder",
	"movablelimits", "largeop", "symmetric", "minsize", "maxsize", "linethickness", "bevelled", "data-id",
	"data-testid", "enterkeyhint", "inputmode", "is", "altglyph", "altglyphdef", "altglyphitem", "animatecolor",
	"animatemotion", "animatetransform", "clippath", "feblend", "fecolormatrix", "fecomponenttransfer",
	"fecomposite", "feconvolvematrix", "fediffuselighting", "fedisplacementmap", "fedistantlight", "feflood",
	"fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge", "femergenode",
	"femorphology", "feoffset", "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence",
	"foreignobject", "glyphref", "lineargradient", "radialgradient", "textpath", "attributename",
	"attributetype", "basefrequency", "baseprofile", "calcmode", "clippathunits", "diffuseconstant", "edgemode",
	"filterunits", "gradienttransform", "gradientunits", "kernelmatrix", "kernelunitlength", "keypoints",
	"keysplines", "keytimes", "lengthadjust", "limitingconeangle", "markerheight", "markerunits", "markerwidth",
	"maskcontentunits", "maskunits", "numoctaves", "pathlength", "patterncontentunits", "patterntransform",
	"patternunits", "pointsatx", "pointsaty", "pointsatz", "preservealpha", "preserveaspectratio",
	"primitiveunits", "refx", "refy", "repeatcount", "repeatdur", "requiredextensions", "requiredfeatures",
	"specularconstant", "specularexponent", "spreadmethod", "startoffset", "stddeviation", "stitchtiles",
	"surfacescale", "systemlanguage", "tablevalues", "targetx", "targety", "textlength", "viewbox",
	"viewtarget", "xchannelselector", "ychannelselector", "zoomandpan", "definitionurl", "altGlyph",
	"altGlyphDef", "altGlyphItem", "animateColor", "animateMotion", "animateTransform", "clipPath", "feBlend",
	"feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
	"feDisplacementMap", "feDistantLight", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
	"feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
	"feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "glyphRef", "linearGradient",
	"radialGradient", "textPath", "attributeName", "attributeType", "baseFrequency", "baseProfile", "calcMode",
	"clipPathUnits", "diffuseConstant", "edgeMode", "filterUnits", "gradientTransform", "gradientUnits",
	"kernelMatrix", "kernelUnitLength", "keyPoints", "keySplines", "keyTimes", "lengthAdjust",
	"limitingConeAngle", "markerHeight", "markerUnits", "markerWidth", "maskContentUnits", "maskUnits",
	"numOctaves", "pathLength", "patternContentUnits", "patternTransform", "patternUnits", "pointsAtX",
	"pointsAtY", "pointsAtZ", "preserveAlpha", "preserveAspectRatio", "primitiveUnits", "refX", "refY",
	"repeatCount", "repeatDur", "requiredExtensions", "requiredFeatures", "specularConstant",
	"specularExponent", "spreadMethod", "startOffset", "stdDeviation", "stitchTiles", "surfaceScale",
	"systemLanguage", "tableValues", "targetX", "targetY", "textLength", "viewBox", "viewTarget",
	"xChannelSelector", "yChannelSelector", "zoomAndPan", "definitionURL",
}

// atomTableSize is a power of two well above len(atomNames), so linear
// probing rarely takes a second step.
const atomTableSize = 2048

// atomTable is an open-addressing hash table over the lowercase names in
// atomNames (names with capitals are adjusted foreign names, never looked
// up). An entry is the atom in the low 16 bits and the top 16 bits of its
// hash above, so most misses and collisions are rejected without a compare.
var atomTable [atomTableSize]uint32

// lowerASCII lowercases A-Z only: HTML names are ASCII case-insensitive.
func lowerASCII(c byte) byte {
	if 'A' <= c && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

// load8 reads 8 bytes little-endian (one load once compiled).
func load8(s string) uint64 {
	_ = s[7]
	return uint64(s[0]) | uint64(s[1])<<8 | uint64(s[2])<<16 | uint64(s[3])<<24 |
		uint64(s[4])<<32 | uint64(s[5])<<40 | uint64(s[6])<<48 | uint64(s[7])<<56
}

// nameWord is the first (up to) eight bytes of s, little-endian, zero-padded.
func nameWord(s string) uint64 {
	if len(s) >= 8 {
		return load8(s)
	}
	var w uint64
	for i := 0; i < len(s); i++ {
		w |= uint64(s[i]) << (8 * i)
	}
	return w
}

// nameHash hashes a lowercase name s from w = nameWord(s), its length and,
// past eight bytes, its last eight: no per-byte work beyond the scan that
// found the name's end.
func nameHash(w uint64, s string) uint32 {
	n := len(s)
	if n > 8 {
		w ^= load8(s[n-8:]) * 0x9E3779B97F4A7C15
	}
	w = (w ^ uint64(n)<<58) * 0xFF51AFD7ED558CCD
	return uint32(w >> 32)
}

// findAtom returns the atom named s (lowercase), given w = nameWord(s), or 0.
// Names compare as one word, plus the tail past eight bytes.
func findAtom(w uint64, s string) atom {
	h := nameHash(w, s)
	tag := h >> 16
	for i := h & (atomTableSize - 1); ; i = (i + 1) & (atomTableSize - 1) {
		e := atomTable[i]
		if e == 0 {
			return 0
		}
		if e>>16 != tag {
			continue
		}
		a := atom(e)
		if atomWord[a] == w && int(atomLen[a]) == len(s) && (len(s) <= 8 || atomNames[a][8:] == s[8:]) {
			return a
		}
	}
}

// lookupAtom returns the atom named s, ignoring ASCII case, or 0.
func lookupAtom(s string) atom {
	for i := 0; i < len(s); i++ {
		if 'A' <= s[i] && s[i] <= 'Z' {
			b := []byte(s)
			for k := range b {
				b[k] = lowerASCII(b[k])
			}
			s = string(b)
			break
		}
	}
	return findAtom(nameWord(s), s)
}

// atomWord and atomLen are nameWord and the length of each atom's name.
var (
	atomWord [len(atomNames)]uint64
	atomLen  [len(atomNames)]uint8
)

// scopeBound[s][a] tells whether an HTML element a bounds scope s (13.2.4.2).
var scopeBound [selectScope + 1][len(atomNames)]bool

// Per-atom tables, filled by init.
var (
	// specialHTML: the HTML "special" elements (Section 13.2.4.3).
	specialHTML [len(atomNames)]bool
	// svgTagFix maps lowercase SVG tag names to their case-adjusted atoms.
	svgTagFix [len(atomNames)]atom
	// svgAttrFix and mathAttrFix do the same for attribute names.
	svgAttrFix  [len(atomNames)]atom
	mathAttrFix [len(atomNames)]atom
)

func init() {
	for a := 1; a < len(atomNames); a++ {
		atomWord[a] = nameWord(atomNames[a])
		atomLen[a] = uint8(len(atomNames[a]))
	}
	for a := 1; a < len(atomNames); a++ {
		name := atomNames[a]
		lower := true
		for i := 0; i < len(name); i++ {
			if 'A' <= name[i] && name[i] <= 'Z' {
				lower = false
				break
			}
		}
		if !lower {
			continue
		}
		if lookupAtom(name) != 0 {
			panic("truffle: duplicate atom " + name)
		}
		h := nameHash(nameWord(name), name)
		i := h & (atomTableSize - 1)
		for atomTable[i] != 0 {
			i = (i + 1) & (atomTableSize - 1)
		}
		atomTable[i] = h>>16<<16 | uint32(a)
	}
	for _, a := range []atom{aAddress, aApplet, aArea, aArticle, aAside, aBase, aBasefont, aBgsound,
		aBlockquote, aBody, aBr, aButton, aCaption, aCenter, aCol, aColgroup, aDd, aDetails, aDir, aDiv,
		aDl, aDt, aEmbed, aFieldset, aFigcaption, aFigure, aFooter, aForm, aFrame, aFrameset, aH1, aH2,
		aH3, aH4, aH5, aH6, aHead, aHeader, aHgroup, aHr, aHtml, aIframe, aImg, aInput, aKeygen, aLi,
		aLink, aListing, aMain, aMarquee, aMenu, aMeta, aNav, aNoembed, aNoframes, aNoscript, aObject,
		aOl, aP, aParam, aPlaintext, aPre, aScript, aSection, aSelect, aSource, aStyle, aSummary,
		aTable, aTbody, aTd, aTemplate, aTextarea, aTfoot, aTh, aThead, aTitle, aTr, aTrack, aUl, aWbr,
		aXmp} {
		specialHTML[a] = true
	}
	for _, a := range []atom{aApplet, aCaption, aHtml, aTable, aTd, aTh, aMarquee, aObject, aTemplate} {
		scopeBound[defaultScope][a] = true
		scopeBound[listItemScope][a] = true
		scopeBound[buttonScope][a] = true
	}
	scopeBound[listItemScope][aOl] = true
	scopeBound[listItemScope][aUl] = true
	scopeBound[buttonScope][aButton] = true
	for _, a := range []atom{aHtml, aTable, aTemplate} {
		scopeBound[tableScope][a] = true
	}
	for a := range scopeBound[selectScope] {
		scopeBound[selectScope][a] = atom(a) != aOptgroup && atom(a) != aOption
	}
	fix := func(table *[len(atomNames)]atom, names ...string) {
		for _, adjusted := range names {
			from, to := lookupAtom(adjusted), atom(0)
			for a := range atomNames {
				if atomNames[a] == adjusted {
					to = atom(a)
				}
			}
			if from == 0 || to == 0 {
				panic("truffle: missing atom for " + adjusted)
			}
			table[from] = to
		}
	}
	fix(&svgTagFix, "altGlyph", "altGlyphDef", "altGlyphItem", "animateColor", "animateMotion",
		"animateTransform", "clipPath", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite",
		"feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feFlood",
		"feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge",
		"feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight",
		"feTile", "feTurbulence", "foreignObject", "glyphRef", "linearGradient", "radialGradient",
		"textPath")
	fix(&svgAttrFix, "attributeName", "attributeType", "baseFrequency", "baseProfile", "calcMode",
		"clipPathUnits", "diffuseConstant", "edgeMode", "filterUnits", "glyphRef", "gradientTransform",
		"gradientUnits", "kernelMatrix", "kernelUnitLength", "keyPoints", "keySplines", "keyTimes",
		"lengthAdjust", "limitingConeAngle", "markerHeight", "markerUnits", "markerWidth",
		"maskContentUnits", "maskUnits", "numOctaves", "pathLength", "patternContentUnits",
		"patternTransform", "patternUnits", "pointsAtX", "pointsAtY", "pointsAtZ", "preserveAlpha",
		"preserveAspectRatio", "primitiveUnits", "refX", "refY", "repeatCount", "repeatDur",
		"requiredExtensions", "requiredFeatures", "specularConstant", "specularExponent",
		"spreadMethod", "startOffset", "stdDeviation", "stitchTiles", "surfaceScale", "systemLanguage",
		"tableValues", "targetX", "targetY", "textLength", "viewBox", "viewTarget", "xChannelSelector",
		"yChannelSelector", "zoomAndPan")
	fix(&mathAttrFix, "definitionURL")
}
