# Exact user-supplied dark palette

`design-theme.json` preserves the palette and role mappings provided by the user.
It supersedes the earlier warm charcoal/off-white design direction. The app remains
dark-only even though the original theme file contains both dark/light role keys.

| Role | Color |
| --- | --- |
| App background, reading canvas, splash | `#000000` |
| Panels, popup surfaces | `#101010` |
| Menu/element surface, border | `#1f1f1f` |
| Main text | `#ededed` |
| Muted text | `#a1a1a1` |
| Active border / subtle decoration | `#676767` |
| Primary / info | `#52a8ff` |
| Secondary | `#c472fb` |
| Accent / success | `#62c073` |
| Warning | `#ff9907` |
| Error | `#f75f8f` |
| Cyan | `#1da9b0` |

Centralize Flutter tokens, apply the same palette to native launch surfaces and
system bars, and set EPUB background/text through the reader adapter. Avoid white
flashes during startup or chapter changes. Publisher images should remain legible
without indiscriminate inversion. Use color sparingly for meaningful states and
interactions. Do not introduce sepia, warm theme variants, or a light-mode toggle.

The code/syntax/diff roles are preserved as supplied data; they do not expand this
EPUB-only app into a code editor or Markdown reader.
