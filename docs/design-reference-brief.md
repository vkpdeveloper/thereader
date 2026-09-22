# Reader design brief informed by Mobbin

The user explicitly requested Mobbin research to guide the Flutter frontend.
The coordinator used Mobbin MCP and visually inspected screen previews before
writing these observations. Reference layouts inform hierarchy and interactions;
the user's exact palette in `design-theme.json` remains authoritative.

## References and specific observations

| Reference | What is visible | Application to The Reader |
| --- | --- | --- |
| [Apple Books library](https://mobbin.com/screens/fb8d6cde-a349-4b0b-a1d5-4fbbc3fce77f) | Large editorial Library heading; cover-led two-column grid; compact top controls and per-book overflow. | Build the library around book covers and titles with sparse controls and ample separation. The app needs no store tab. |
| [Blinkist library](https://mobbin.com/screens/7cec730b-97f5-48c2-9ccb-4846a2d8ef69) | Distinct In progress section with a thin progress line, followed by labeled Saved and Downloads rows. | One clear continue-reading entry and a discoverable downloaded filter. Avoid duplicating the same book in several competing feature cards. |
| [Apple Books reader](https://mobbin.com/screens/41c4249c-46da-4ae4-a92b-4ae761cceb80) | Book text dominates the screen; compact progress information and a small menu control sit near screen edges. | Keep reading content primary. Reveal controls on tap; remove library navigation from the reading surface. |
| [Matter black reading settings](https://mobbin.com/screens/c9f61846-1003-48cf-acc9-df7c8c970ddc) | A dark bottom sheet leaves the publication visible above it. Aligned rows expose font, size, spacing, and width. | Use one focused typography sheet with an immediate visible effect on the book; align labels and controls consistently. Keep the original black palette as Default; optional dark presets now live in Settings, following the later theme request. |
| [Fable typography sheet](https://mobbin.com/screens/8ed9301b-98de-4652-8715-c364cd8d8cab) | Compact font-family choices and a size slider below the still-visible book. | Make a few meaningful font choices easy to compare. Typography changes should preserve reading position. |
| [Apple Books dark appearance sheet](https://mobbin.com/screens/e934326b-c637-4937-9a5f-6b05c3cc0a08) | Dark publication behind a sheet with grouped appearance controls and large tappable options. | Maintain separation through dark surface levels and generous targets. Do not import its multiple themes or decorative controls. |

These screenshots establish visible layout patterns only. They do not establish
animation timing, implementation technology, or measured performance.

## Visual direction

- Pure black canvas; #101010 panels; #1f1f1f control surfaces and dividers.
- #ededed primary text, #a1a1a1 supporting text. Reserve #676767 for genuinely
  secondary decoration/active-border roles; do not use it for essential small copy.
- #52a8ff for meaningful primary actions or selection; semantic status colors from
  the supplied palette. Book covers may carry the book's own artwork/colors.
- Use a restrained typographic hierarchy. Inter works for UI, Literata for reading.
  An editorial heading can add character without making every label decorative.
- Prefer spacing and crisp hairline borders to a stack of boxed cards. Avoid
  gradients, neon glows, oversized pills, and heavy blur over the native reader.
- Preserve book-cover aspect ratios, provide intentional typographic fallbacks,
  truncate long titles gracefully, and never rely on remote imagery for sample mode.

## Screen decisions

### Library

A clear Library title, quiet search/settings access, one continue-reading entry,
then the collection. Use a two-column cover grid on ordinary phone widths with
responsive density on larger screens. Offer simple All/Downloaded/In progress
filters only if backed by real state. Show concise title/author and an unobtrusive
download or progress indicator. Keep sample mode visibly separate from live data.

### Book detail

A cover, readable title and author, concise description, and one primary action
whose meaning matches state: Download, Read, or Continue. Show actual transfer
progress with cancellation/error/retry where implemented. Do not present offline
availability until checksum verification and durable persistence complete.

### Reader

The publication fills the black reading canvas with comfortable margins and a
readable measure. Controls should be compact and discoverable when revealed.
Keep content selection, page gestures, and system navigation from competing with
each other. Provide contents, search, typography and progress only when functional.
Preserve book location after closing settings, rotating, or leaving/reopening.

### Typography and settings

Use a focused #101010 bottom sheet with a visible publication preview above it.
Keep font selection, text size, line height and margins clearly grouped and ordered.
No light/sepia option. App settings contain connection and local-storage controls,
not account/profile screens. Be honest about unsupported reading modes.

## Interaction and quality gates

- Proposed motion: brief, restrained transitions, approximately 140–220 ms for
  small controls, with immediate press feedback. These are design targets, not
  timing values inferred from screenshots.
- Respect reduced motion, larger text and screen-reader semantics. Maintain
  comfortably tappable controls; visual minimalism must not shrink hit targets.
- Avoid layout jumps as covers load. Defer work that is unrelated to the visible
  book. Keep reader host identity stable while showing or hiding app controls.
- Check exact black launch/background/reader surfaces and remove white flashes.
- Inspect long technical titles, missing covers, empty and offline library states,
  active downloads, error states and native text-selection menus on the simulator.
- Every visible control must work or clearly explain its current limitation.

## Local reference files

High-resolution references were downloaded from Mobbin's provided image URLs into
the gitignored `artifacts/private/design-references/` directory for visual inspection.
Do not ship these screenshots as app assets or commit them. Cite canonical Mobbin
screen links above; image URLs expire. The implementation should be original.
