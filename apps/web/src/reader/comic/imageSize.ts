import type { PageSize } from './layout';

/**
 * Pixel size from the first bytes of an image, so spreads can be laid out
 * before pages decode. Returns null when the header is not (fully) there;
 * the decoded image corrects it either way.
 */
export function sniffImageSize(b: Uint8Array): PageSize | null {
  if (b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: IHDR is the first chunk.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return size(v.getUint32(16), v.getUint32(20));
  }
  // GIF87a / GIF89a: logical screen size.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return size(v.getUint16(6, true), v.getUint16(8, true));
  }
  // BMP: BITMAPINFOHEADER (or larger) width / height (negative height is top-down).
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    return size(Math.abs(v.getInt32(18, true)), Math.abs(v.getInt32(22, true)));
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return size(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') {
      return size(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
    }
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1]!;
      if (marker === 0xff) {
        p += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return size(v.getUint16(p + 7), v.getUint16(p + 5));
      p += 2 + v.getUint16(p + 2);
    }
  }
  return null;
}

function size(width: number, height: number): PageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function ascii(b: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...b.subarray(at, at + length));
}

/** MIME type for a page entry name, so blobs decode with the right type. */
export function pageMimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}
