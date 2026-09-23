# Reader typography validation

Validated against the private local EPUB used in the reported screenshots:
chapter 4 of *Build a Large Language Model (From Scratch)*. Book contents,
images, recordings, app-state backups and APKs stay in ignored artifacts.

## Automated checks

- Flutter analyzer: clean. Flutter tests: 120 passed, including preference
  compatibility, picker semantics and the theme helper's DOM behavior.
- Worker tests: 44 passed; TypeScript checks pass.
- CodeRabbit: the accessibility and root-inline-style findings were fixed.
  The final font-route review suggested a missing navigator declaration; this
  was dismissed after verifying `HostFontFamilies.declareIn` already runs in
  `EpubReaderFragment.attachNavigator`, and proving loaded faces in the WebView.
- Real Chromium rendering: the synthetic publisher-color fixture follows four
  dark palettes, including inline `!important` on the document root and body.
  SVG inline styles and Readium highlight backgrounds remain intact.
- Android's actual Readium WebView: computed colors for the real chapter's
  heading, nested title, figure caption, number label, prose and code match
  all six palettes under both Readium CSS flow settings. This exercises live
  CSS variable changes; it is not a measurement of pagination performance.

## iOS simulator

Built and ran on iPhone 17 / iOS 26.5. The reported chapter heading and figure
4.2 caption now use Gruvbox ink. The figure's original pixels remain intact.
All seven font selections were exercised on the same locally stored chapter,
with screenshots showing distinct bundled faces and preserved bold/italic text.
Dracula was checked after changing the theme in Settings. Nord with Lexend
was also checked after selecting paginated preferences and advancing a page.
The original simulator preferences and library were restored afterward.

These are functional simulator checks, not physical-device performance
measurements. No battery, thermal or sustained device-frame-rate claims are
made. The theme helper runs once per document and has no observer or frame loop.

## Deployment

Optional `fontFamilyId` syncing deployed to `reader.ordinity.com`, Worker
version `3675bc87-997b-4763-a6dc-04cd5968db11`. The health endpoint returned OK.
The existing `font` remains `serif` or `sans` for compatibility with older apps.
The preferences remain in the existing D1 JSON document; no migration is needed.

## Android font delivery

Readium 3.2's assets origin lacks CORS headers. Initial native testing caught
font fallback despite successful builds. The final implementation serves only
declared bundled font names on the publication origin through `HostFontContainer`;
it does not relax WebView security or expose other app files.

In the actual Android WebView, all nine font faces report `loaded` (regular and
italic for four families, plus Lexend regular). Actual color checks pass for all
six presets in both CSS flow settings. No font CORS errors remain. The picker
was also exercised through the app UI, checking the computed paragraph family.

Release APK: 0.1.0 build 2012, arm64, Android versionCode 4012, app label
The Reader. APK signature verification passes (v2). SHA-256:
`2e5c24612f851b85f3d588b1a63d86a7e699185b5b7659f2b385b0b055e97198`.

The release APK was installed on the Android emulator and reopened the cached
EPUB after a force-stop with airplane mode on and Wi-Fi/data disabled. Lexend
remained selected, and both text and figures rendered. Networking and the
original Android app state were restored afterward.

The APK was accepted by Taildrop for Nord. This confirms transfer acceptance,
not installation on the physical phone.

## Private recordings

- `artifacts/recordings/ios-typography-tested.mp4`: iOS heading/caption checks,
  all font choices, theme changes and page navigation.
- `artifacts/recordings/android-typography-tested.mp4`: Android font picker
  walkthrough followed by the release build's offline reading check.

Recordings are normalized to 30 fps for playback, kept outside Git, and sent
separately. Simulator/emulator testing does not substitute for physical-device
performance measurements.
