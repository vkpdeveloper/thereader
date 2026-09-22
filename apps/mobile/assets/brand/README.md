# Brand mark

A page with a bookmark ribbon on pure black. Colours come from
`docs/design-theme.json`: background `#000000`, page `#ededed`, ribbon `#52a8ff`.

`tool/brand/render_brand.dart` is the single source of truth. It holds the
geometry and writes, deterministically:

- the SVGs in this directory (`icon.svg`, `mark.svg`, `mark-mono.svg`, and the
  108-unit Android adaptive foreground/monochrome variants);
- every iOS `AppIcon.appiconset` raster and the `LaunchImage` set (96 pt mark);
- Android legacy `mipmap-*/ic_launcher.png`, adaptive `ic_launcher_foreground.png`,
  themed `ic_launcher_monochrome.png`, and `drawable/splash_mark.xml`;
- the web favicon and manifest icons.

Regenerate after any geometry change:

```sh
cd apps/mobile && dart run tool/brand/render_brand.dart
```

These files are not Flutter assets; nothing here is bundled by `pubspec.yaml`.
