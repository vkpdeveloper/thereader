// The Reader brand mark: a page with a bookmark ribbon.
//
// Single source of truth for the app icon, adaptive/monochrome Android icons,
// iOS icons, launch/splash marks and web icons. Everything here is plain
// geometry rendered by a tiny analytic rasteriser, so every output is
// reproducible byte-for-byte with:
//
//   dart run tool/brand/render_brand.dart
//
// Palette follows docs/design-theme.json exactly: bg #000000, fg #ededed,
// primary #52a8ff. No other colours, no gradients, no shadows.
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

// ---------------------------------------------------------------------------
// Geometry, in a 1024×1024 icon space.
// ---------------------------------------------------------------------------

const double canvas = 1024;

/// Page: rounded rectangle, the only large shape.
const double pageX = 272, pageY = 212, pageW = 480, pageH = 600, pageR = 52;

/// Ribbon: hangs from the page top, ends in a V notch.
const double ribbonX = 540, ribbonW = 112, ribbonBottom = 632, ribbonNotch = 44;

const List<List<double>> ribbon = [
  [ribbonX, pageY],
  [ribbonX + ribbonW, pageY],
  [ribbonX + ribbonW, ribbonBottom],
  [ribbonX + ribbonW / 2, ribbonBottom - ribbonNotch],
  [ribbonX, ribbonBottom],
];

const int bg = 0xFF000000;
const int fg = 0xFFEDEDED;
const int blue = 0xFF52A8FF;

// ---------------------------------------------------------------------------
// Signed distance functions.
// ---------------------------------------------------------------------------

double sdRoundedRect(double px, double py) {
  final cx = pageX + pageW / 2, cy = pageY + pageH / 2;
  final hx = pageW / 2 - pageR, hy = pageH / 2 - pageR;
  final qx = (px - cx).abs() - hx, qy = (py - cy).abs() - hy;
  final ox = math.max(qx, 0.0), oy = math.max(qy, 0.0);
  return math.sqrt(ox * ox + oy * oy) + math.min(math.max(qx, qy), 0.0) - pageR;
}

double sdPolygon(List<List<double>> pts, double px, double py) {
  var d = double.infinity;
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    final ax = pts[j][0], ay = pts[j][1], bx = pts[i][0], by = pts[i][1];
    final ex = bx - ax, ey = by - ay;
    final wx = px - ax, wy = py - ay;
    final t = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
    final dx = wx - ex * t, dy = wy - ey * t;
    d = math.min(d, dx * dx + dy * dy);
    if ((ay > py) != (by > py) && px < ax + (py - ay) * ex / ey) inside = !inside;
  }
  return (inside ? -1 : 1) * math.sqrt(d);
}

/// Pixel coverage from a signed distance in output pixels.
double coverage(double d) => (0.5 - d).clamp(0.0, 1.0);

// ---------------------------------------------------------------------------
// Raster.
// ---------------------------------------------------------------------------

class Raster {
  Raster(this.size) : rgba = Float64List(size * size * 4);
  final int size;
  final Float64List rgba; // straight alpha, 0..1

  void fill(int argb) {
    final a = ((argb >> 24) & 255) / 255, r = ((argb >> 16) & 255) / 255;
    final g = ((argb >> 8) & 255) / 255, b = (argb & 255) / 255;
    for (var i = 0; i < size * size; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
  }

  /// Source-over one colour with per-pixel coverage.
  void blend(int argb, double Function(double x, double y) cov) {
    final r = ((argb >> 16) & 255) / 255, g = ((argb >> 8) & 255) / 255, b = (argb & 255) / 255;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        final c = cov(x + 0.5, y + 0.5);
        if (c <= 0) continue;
        final i = (y * size + x) * 4;
        final da = rgba[i + 3];
        final oa = c + da * (1 - c);
        if (oa <= 0) continue;
        rgba[i] = (r * c + rgba[i] * da * (1 - c)) / oa;
        rgba[i + 1] = (g * c + rgba[i + 1] * da * (1 - c)) / oa;
        rgba[i + 2] = (b * c + rgba[i + 2] * da * (1 - c)) / oa;
        rgba[i + 3] = oa;
      }
    }
  }

  /// Multiply alpha by (1 - coverage): cuts a hole.
  void cut(double Function(double x, double y) cov) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        final c = cov(x + 0.5, y + 0.5);
        if (c <= 0) continue;
        rgba[(y * size + x) * 4 + 3] *= 1 - c;
      }
    }
  }

  /// Fully opaque images are written as RGB: App Store icons must not carry
  /// an alpha channel, and it keeps the files smaller.
  Uint8List toPng() {
    var opaque = true;
    for (var i = 3; i < rgba.length; i += 4) {
      if (rgba[i] < 1) {
        opaque = false;
        break;
      }
    }
    final channels = opaque ? 3 : 4;
    final raw = BytesBuilder();
    for (var y = 0; y < size; y++) {
      raw.addByte(0);
      for (var x = 0; x < size; x++) {
        final i = (y * size + x) * 4;
        for (var k = 0; k < channels; k++) {
          raw.addByte((rgba[i + k] * 255).round().clamp(0, 255));
        }
      }
    }
    final idat = ZLibEncoder(level: 9).convert(raw.takeBytes());
    final out = BytesBuilder();
    out.add(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    final ihdr = ByteData(13)
      ..setUint32(0, size)
      ..setUint32(4, size)
      ..setUint8(8, 8)
      ..setUint8(9, opaque ? 2 : 6)
      ..setUint8(10, 0)
      ..setUint8(11, 0)
      ..setUint8(12, 0);
    _chunk(out, 'IHDR', ihdr.buffer.asUint8List());
    _chunk(out, 'IDAT', Uint8List.fromList(idat));
    _chunk(out, 'IEND', Uint8List(0));
    return out.takeBytes();
  }

  static void _chunk(BytesBuilder out, String type, Uint8List data) {
    final len = ByteData(4)..setUint32(0, data.length);
    out.add(len.buffer.asUint8List());
    final body = Uint8List.fromList([...type.codeUnits, ...data]);
    out.add(body);
    final crc = ByteData(4)..setUint32(0, _crc32(body));
    out.add(crc.buffer.asUint8List());
  }

  static final List<int> _crcTable = List.generate(256, (n) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
    }
    return c;
  });

  static int _crc32(Uint8List bytes) {
    var c = 0xFFFFFFFF;
    for (final b in bytes) {
      c = _crcTable[(c ^ b) & 255] ^ (c >> 8);
    }
    return (c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
  }
}

/// The mark (page + ribbon) drawn into a raster of [size] pixels, with the
/// 1024 icon space scaled by [scale] and centred.
/// [mono] renders a single-colour mark with the ribbon cut out.
void drawMark(Raster r, {required double scale, bool mono = false, int ink = fg}) {
  final offset = (r.size - canvas * scale) / 2;
  double ix(double x) => (x - offset) / scale;
  double page(double x, double y) => coverage(sdRoundedRect(ix(x), ix(y)) * scale);
  double rib(double x, double y) => coverage(sdPolygon(ribbon, ix(x), ix(y)) * scale);
  r.blend(ink, page);
  if (mono) {
    r.cut(rib);
  } else {
    r.blend(blue, rib);
  }
}

double sdRoundedSquare(double px, double py, double size, double radius) {
  final h = size / 2 - radius;
  final qx = (px - size / 2).abs() - h, qy = (py - size / 2).abs() - h;
  final ox = math.max(qx, 0.0), oy = math.max(qy, 0.0);
  return math.sqrt(ox * ox + oy * oy) + math.min(math.max(qx, qy), 0.0) - radius;
}

/// Full icon: black square (iOS masks its own corners) or rounded square for
/// legacy Android launchers, with the mark at icon scale.
Uint8List icon(int size, {double cornerFraction = 0}) {
  final r = Raster(size);
  if (cornerFraction == 0) {
    r.fill(bg);
  } else {
    final radius = size * cornerFraction;
    r.blend(bg, (x, y) => coverage(sdRoundedSquare(x, y, size.toDouble(), radius)));
  }
  drawMark(r, scale: size / canvas);
  return r.toPng();
}

/// Android adaptive foreground (108dp canvas, 66dp safe zone) or monochrome.
Uint8List adaptive(int size, {required bool mono}) {
  final r = Raster(size);
  r.fill(0x00000000);
  drawMark(r, scale: size * (66 / 108) / canvas, mono: mono);
  return r.toPng();
}

/// Transparent launch mark, sized so the page is [size] pixels tall.
Uint8List splash(int size) {
  final r = Raster(size);
  r.fill(0x00000000);
  drawMark(r, scale: size / canvas);
  return r.toPng();
}

// ---------------------------------------------------------------------------
// Vector exports from the same numbers.
// ---------------------------------------------------------------------------

String hex(int argb) => '#${(argb & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';
String n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

String pagePath() {
  final x = pageX, y = pageY, w = pageW, h = pageH, r = pageR;
  return 'M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}'
      'V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}'
      'A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z';
}

String ribbonPath() =>
    'M${ribbon.map((p) => '${n(p[0])} ${n(p[1])}').join('L')}Z';

String svg({required bool background, required bool mono, double viewBox = canvas, double? contentScale}) {
  final scale = contentScale ?? 1;
  final offset = (viewBox - canvas * scale) / 2;
  final b = StringBuffer()
    ..writeln('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(viewBox)} ${n(viewBox)}">');
  if (background) b.writeln('  <rect width="${n(viewBox)}" height="${n(viewBox)}" fill="${hex(bg)}"/>');
  b.writeln('  <g transform="translate(${n(offset)} ${n(offset)}) scale(${n(scale)})">');
  if (mono) {
    b.writeln('    <path fill="${hex(fg)}" fill-rule="evenodd" d="${pagePath()}${ribbonPath()}"/>');
  } else {
    b.writeln('    <path fill="${hex(fg)}" d="${pagePath()}"/>');
    b.writeln('    <path fill="${hex(blue)}" d="${ribbonPath()}"/>');
  }
  b
    ..writeln('  </g>')
    ..writeln('</svg>');
  return b.toString();
}

/// Android VectorDrawable of the mark, 96dp, for the pre-31 launch window.
String vectorDrawable() => '''
<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by tool/brand/render_brand.dart. Do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="96dp"
    android:height="96dp"
    android:viewportWidth="${n(canvas)}"
    android:viewportHeight="${n(canvas)}">
    <path
        android:fillColor="${hex(fg)}"
        android:pathData="${pagePath()}" />
    <path
        android:fillColor="${hex(blue)}"
        android:pathData="${ribbonPath()}" />
</vector>
''';

// ---------------------------------------------------------------------------
// Outputs.
// ---------------------------------------------------------------------------

void write(String path, List<int> bytes) {
  File(path)
    ..createSync(recursive: true)
    ..writeAsBytesSync(bytes);
  stdout.writeln('  $path');
}

void main() {
  final root = Directory.current.path.endsWith('/tool/brand')
      ? '${Directory.current.path}/../..'
      : Directory.current.path;
  final brand = '$root/assets/brand';
  final ios = '$root/ios/Runner/Assets.xcassets';
  final res = '$root/android/app/src/main/res';
  final web = '$root/web';

  stdout.writeln('Vector sources');
  write('$brand/icon.svg', svg(background: true, mono: false).codeUnits);
  write('$brand/mark.svg', svg(background: false, mono: false).codeUnits);
  write('$brand/mark-mono.svg', svg(background: false, mono: true).codeUnits);
  write('$brand/icon-adaptive-foreground.svg',
      svg(background: false, mono: false, viewBox: 108, contentScale: 66 / canvas).codeUnits);
  write('$brand/icon-adaptive-monochrome.svg',
      svg(background: false, mono: true, viewBox: 108, contentScale: 66 / canvas).codeUnits);
  write('$res/drawable/splash_mark.xml', vectorDrawable().codeUnits);

  stdout.writeln('iOS app icon');
  const iosSizes = <String, int>{
    'Icon-App-20x20@1x': 20, 'Icon-App-20x20@2x': 40, 'Icon-App-20x20@3x': 60,
    'Icon-App-29x29@1x': 29, 'Icon-App-29x29@2x': 58, 'Icon-App-29x29@3x': 87,
    'Icon-App-40x40@1x': 40, 'Icon-App-40x40@2x': 80, 'Icon-App-40x40@3x': 120,
    'Icon-App-60x60@2x': 120, 'Icon-App-60x60@3x': 180,
    'Icon-App-76x76@1x': 76, 'Icon-App-76x76@2x': 152,
    'Icon-App-83.5x83.5@2x': 167, 'Icon-App-1024x1024@1x': 1024,
  };
  for (final e in iosSizes.entries) {
    write('$ios/AppIcon.appiconset/${e.key}.png', icon(e.value));
  }

  stdout.writeln('iOS launch mark (96pt)');
  write('$ios/LaunchImage.imageset/LaunchImage.png', splash(96));
  write('$ios/LaunchImage.imageset/LaunchImage@2x.png', splash(192));
  write('$ios/LaunchImage.imageset/LaunchImage@3x.png', splash(288));

  stdout.writeln('Android launcher icons');
  const densities = <String, int>{'mdpi': 1, 'hdpi': 2, 'xhdpi': 3, 'xxhdpi': 4, 'xxxhdpi': 5};
  const legacyPx = <String, int>{'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192};
  const adaptivePx = <String, int>{'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432};
  for (final d in densities.keys) {
    // Legacy launchers (API < 26) draw this as-is, so it carries its own corners.
    write('$res/mipmap-$d/ic_launcher.png', icon(legacyPx[d]!, cornerFraction: 0.18));
    write('$res/mipmap-$d/ic_launcher_foreground.png', adaptive(adaptivePx[d]!, mono: false));
    write('$res/mipmap-$d/ic_launcher_monochrome.png', adaptive(adaptivePx[d]!, mono: true));
  }

  stdout.writeln('Web icons');
  write('$web/favicon.png', icon(64, cornerFraction: 0.18));
  write('$web/icons/Icon-192.png', icon(192, cornerFraction: 0.18));
  write('$web/icons/Icon-512.png', icon(512, cornerFraction: 0.18));
  write('$web/icons/Icon-maskable-192.png', icon(192));
  write('$web/icons/Icon-maskable-512.png', icon(512));
}
