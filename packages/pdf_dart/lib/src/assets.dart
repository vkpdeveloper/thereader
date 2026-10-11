part of pdf_extractor;

Uint8List _encodePNG(Uint8List rgba, int width, int height) {
  if (width < 1 || height < 1 || rgba.length != width * height * 4) _invalid();
  final rows = Uint8List((width * 4 + 1) * height);
  for (var y = 0; y < height; y++)
    rows.setRange(
      y * (width * 4 + 1) + 1,
      y * (width * 4 + 1) + 1 + width * 4,
      rgba,
      y * width * 4,
    );
  Uint8List chunk(String kind, Uint8List data) {
    final b = Uint8List(data.length + 12), view = ByteData.sublistView(b);
    view.setUint32(0, data.length);
    b.setRange(4, 8, kind.codeUnits);
    b.setRange(8, 8 + data.length, data);
    view.setUint32(b.length - 4, archive.getCrc32(_slice(b, 4, b.length - 4)));
    return b;
  }

  final header = Uint8List(13), view = ByteData.sublistView(header);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  final chunks = [
    Uint8List.fromList([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', archive.ZLibEncoderWeb().encodeBytes(rows, level: 1)),
    chunk('IEND', Uint8List(0)),
  ];
  final out = Uint8List(chunks.fold<int>(0, (n, b) => n + b.length));
  var at = 0;
  for (final b in chunks) {
    out.setRange(at, at + b.length, b);
    at += b.length;
  }
  return out;
}

class _Assets {
  final _PDF p;
  final names = <String>{};
  _Assets(this.p);
  String add(
    Uint8List data,
    String mediaType,
    String ext,
    int width,
    int height,
  ) {
    final name =
        'assets/${crypto.sha256.convert(data).toString().substring(0, 24)}.$ext';
    if (names.contains(name)) return name;
    if (data.length > p.limits.assetBytes - p.assetBytes - p.outlineBytes)
      _limit();
    p.assetBytes += data.length;
    names.add(name);
    p.out.assets.add(Asset(name, mediaType, width, height, data));
    return name;
  }

  String png(Uint8List data, int w, int h) {
    final encoded = _encodePNG(data, w, h);
    p.decodedSize += encoded.length;
    if (p.decodedSize > p.limits.decodedBytes) _limit();
    return add(encoded, 'image/png', 'png', w, h);
  }
}
