import { zlibSync } from "fflate";
import { PDF } from "./parser";
import { sha256 } from "./hash";
import { invalid, limit } from "./model";
import { bytes } from "./syntax";

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let j = 0; j < 8; j++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const n of b) c = (c >>> 8) ^ crcTable[(c ^ n) & 255];
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Uint8Array): Uint8Array {
  const b = new Uint8Array(data.length + 12),
    view = new DataView(b.buffer);
  view.setUint32(0, data.length);
  b.set(bytes(kind), 4);
  b.set(data, 8);
  view.setUint32(b.length - 4, crc32(b.subarray(4, -4)));
  return b;
}
export function encodePNG(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(width * height) ||
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4
  )
    invalid();
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(rows, { level: 1 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of chunks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
export class Assets {
  readonly names = new Set<string>();
  constructor(readonly p: PDF) {}
  add(
    data: Uint8Array,
    mediaType: string,
    ext: string,
    width: number,
    height: number,
  ): string {
    const name = `assets/${sha256(data).slice(0, 24)}.${ext}`;
    if (this.names.has(name)) return name;
    if (
      data.length >
      this.p.limits.assetBytes - this.p.assetBytes - this.p.outlineBytes
    )
      limit();
    this.p.assetBytes += data.length;
    this.names.add(name);
    // Assets own their buffers: raw JPEG streams may otherwise share the PDF buffer.
    this.p.out.assets.push({
      name,
      mediaType,
      width,
      height,
      data: data.slice(),
    });
    return name;
  }
  png(data: Uint8Array, w: number, h: number): string {
    const encoded = encodePNG(data, w, h);
    this.p.decodedSize += encoded.length;
    if (this.p.decodedSize > this.p.limits.decodedBytes) limit();
    return this.add(encoded, "image/png", "png", w, h);
  }
}
