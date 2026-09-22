# Theme presets

The mobile app ships six dark colour presets. `Default` is the exact Vercel-dark
palette the app launched with (`Palette` in `core/theme/tokens.dart`) and is
what every install shows until a preset is chosen. The other five are mapped
from the official palettes named below. There is no light theme.

## How it works

- `core/theme/app_colors.dart` defines `AppColors`, a `ThemeExtension` with the
  same role names as `Palette` (`bg`, `panel`, `element`, `border`,
  `borderActive`, `fg`, `muted`, `subtle`, six accents), plus `paper` / `ink`
  for the reading surface and an `accents` list for generated cover art.
  Widgets read `context.colors` (or `AppColors.of(context)`).
- `core/theme/theme_presets.dart` holds the presets. `ThemePreset.byId` falls
  back to Default for a null or unknown id, so a newer device's choice never
  breaks an older build.
- `core/theme/app_theme.dart` builds the `ThemeData` (and system bar overlay)
  for any `AppColors`. `AppTheme.dark` remains the Default theme.
- The choice is stored as the optional `ReaderPreferences.themeId`, so it is
  persisted locally and synced through the existing preference sync. Absent
  means Default. The API validates ids against the same list:
  `default`, `dracula`, `nord`, `tokyo-night`, `catppuccin-mocha`, `gruvbox`.
- `TheReaderApp` rebuilds `MaterialApp`'s theme when the preference changes,
  so every open route, sheet and dialog re-themes at once. Native Readium
  receives `paper` / `ink` as its `backgroundColor` / `textColor` preferences
  on open and again on every preference change; the Dart engine derives its
  HTML element styles from the same colours. No vendored plugin change was
  needed. The plugin's helper CSS still gives publisher images a fixed light
  backing (`#ededed`) on every preset; that is intentional so diagrams stay
  legible regardless of the canvas.
- The native launch splash stays black.

## Role mapping and sources

Each preset maps official palette colours onto the app's roles. Where a palette
has no exact neutral for a role, the value comes from the project's own UI
theme (noted per preset). Accent roles keep their app names (`blue`, `pink`,
etc.); `pink` is the app's error tone, so it takes each palette's red/pink
error colour.

### Dracula
Source: https://draculatheme.com/contribute (palette) and
https://github.com/dracula/visual-studio-code (`src/dracula.yml`, MIT) for the
UI neutrals.

| Role | Value | Origin |
|---|---|---|
| bg | `#282A36` | Background |
| panel | `#21222C` | VS Code theme `BGDark` (sidebar) |
| element, border | `#44475A` | Current Line / Selection |
| borderActive, subtle | `#6272A4` | Comment |
| fg | `#F8F8F2` | Foreground |
| muted | `#BFC7D5` | Derived: Foreground mixed toward Comment for a legible secondary text (Dracula has no official mid-grey) |
| blue, cyan | `#8BE9FD` | Cyan |
| purple | `#BD93F9` | Purple |
| green | `#50FA7B` | Green |
| orange | `#FFB86C` | Orange |
| pink (error) | `#FF79C6` | Pink |

### Nord
Source: https://www.nordtheme.com/docs/colors-and-palettes (MIT).

| Role | Value | Origin |
|---|---|---|
| bg | `#2E3440` | nord0 |
| panel | `#3B4252` | nord1 |
| element, border | `#434C5E` | nord2 |
| borderActive | `#4C566A` | nord3 |
| fg | `#ECEFF4` | nord6 |
| muted | `#D8DEE9` | nord4 |
| subtle | `#7B88A1` | nord3 brightened, as used by Nord's own editor ports for comments |
| blue | `#88C0D0` | nord8 (primary UI accent) |
| purple | `#B48EAD` | nord15 |
| green | `#A3BE8C` | nord14 |
| orange | `#D08770` | nord12 |
| pink (error) | `#BF616A` | nord11 |
| cyan | `#8FBCBB` | nord7 |

### Tokyo Night
Source: https://github.com/tokyo-night/tokyo-night-vscode-theme (README palette
table and `themes/tokyo-night-color-theme.json`, MIT).

| Role | Value | Origin |
|---|---|---|
| bg | `#1A1B26` | Editor background |
| panel | `#16161E` | Sidebar / widget background |
| element | `#292E42` | Line highlight surface |
| border | `#232433` | Indent guide |
| borderActive | `#414868` | Terminal black |
| fg | `#C0CAF5` | Terminal white / variables |
| muted | `#A9B1D6` | Editor foreground |
| subtle | `#565F89` | Comments |
| blue | `#7AA2F7` | Blue |
| purple | `#BB9AF7` | Magenta |
| green | `#9ECE6A` | Green |
| orange | `#FF9E64` | Orange |
| pink (error) | `#F7768E` | Red |
| cyan | `#7DCFFF` | Cyan |

### Catppuccin Mocha
Source: https://catppuccin.com/palette (MIT).

| Role | Value | Origin |
|---|---|---|
| bg | `#1E1E2E` | Base |
| panel | `#181825` | Mantle |
| element, border | `#313244` | Surface0 |
| borderActive | `#585B70` | Surface2 |
| fg | `#CDD6F4` | Text |
| muted | `#A6ADC8` | Subtext0 |
| subtle | `#6C7086` | Overlay0 |
| blue | `#89B4FA` | Blue |
| purple | `#CBA6F7` | Mauve |
| green | `#A6E3A1` | Green |
| orange | `#FAB387` | Peach |
| pink (error) | `#F38BA8` | Red |
| cyan | `#89DCEB` | Sky |

### Gruvbox (dark, medium contrast)
Source: https://github.com/morhetz/gruvbox (`colors/gruvbox.vim`, MIT).

| Role | Value | Origin |
|---|---|---|
| bg | `#282828` | dark0 |
| panel | `#1D2021` | dark0_hard |
| element, border | `#3C3836` | dark1 |
| borderActive | `#665C54` | dark3 |
| fg | `#EBDBB2` | light1 |
| muted | `#A89984` | light4 |
| subtle | `#928374` | gray |
| blue | `#83A598` | bright_blue |
| purple | `#D3869B` | bright_purple |
| green | `#B8BB26` | bright_green |
| orange | `#FE8019` | bright_orange |
| pink (error) | `#FB4934` | bright_red |
| cyan | `#8EC07C` | bright_aqua |

For every preset `paper` = `bg` and `ink` = `fg`. `test/theme_test.dart`
asserts that every preset is dark, that body text meets 7:1 against its
canvas and secondary text 4.5:1, and that Default equals `Palette` exactly.

## Adding a preset

1. Add a `ThemePreset` constant in `theme_presets.dart` and append it to
   `ThemePreset.all`.
2. Add the id to the API's accepted list.
3. Document the source and mapping here.
