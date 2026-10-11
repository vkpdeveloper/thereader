part of pdf_extractor;

List<int> _cmykRGB(int c, int m, int y, int k) =>
    [c, m, y].map((v) => (((255 - v) * (255 - k) * 257) ~/ 255) >> 8).toList();
int _gray(int r, int g, int b) =>
    ((19595 * r * 257 + 38470 * g * 257 + 7471 * b * 257 + 32768) ~/ 65536) >>
    8;
(int, int) _jpegSize(Uint8List b) {
  if (b.length < 2 || b[0] != 255 || b[1] != 216)
    _invalid('Invalid JPEG image');
  var at = 2;
  while (at < b.length) {
    if (b[at++] != 255) _invalid('Invalid JPEG marker');
    while (at < b.length && b[at] == 255) at++;
    if (at >= b.length) _invalid();
    final marker = b[at++];
    if (marker == 217 || marker == 218) break;
    if (marker == 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > b.length) _invalid();
    final length = b[at] * 256 + b[at + 1];
    if (length < 2 || length > b.length - at) _invalid();
    if (const [192, 193, 194].contains(marker)) {
      if (length < 8) _invalid();
      return (b[at + 5] * 256 + b[at + 6], b[at + 3] * 256 + b[at + 4]);
    }
    at += length;
  }
  return _invalid('Missing JPEG frame');
}

class _Images extends _ImageReader {
  final _PDF p;
  final _Assets assets;
  _Images(this.p, this.assets);
  void budget(int size) {
    if (size > p.limits.decodedBytes - p.decodedSize) _limit();
    p.decodedSize += size;
  }

  Uint8List jpeg(Uint8List b, int w, int h) {
    final (width, height) = _jpegSize(b);
    if (w != width || h != height) _invalid('Invalid JPEG dimensions');
    budget(w * h * 8);
    final image = img.decodeJpg(b);
    if (image == null || image.width != w || image.height != h)
      _invalid('Invalid JPEG image');
    return image.getBytes(order: img.ChannelOrder.rgba);
  }

  @override
  String image(_Stream s, int page) {
    final cached = p.assetIDs[s];
    if (cached != null) return cached;
    final w = _integer(p.resolve(s.dict['Width'])),
        h = _integer(p.resolve(s.dict['Height']));
    if (w <= 0 || h <= 0 || w > p.limits.imagePixels / h) _limit();
    final (b, kind) = p.decodeFilters(s);
    late String id;
    if (kind == 'DCTDecode' || kind == 'DCT') {
      if (s.dict['Mask'] != null)
        p.warn(
          'image-mask',
          page,
          'Color-key or explicit image masks are not applied.',
        );
      final (width, height) = _jpegSize(b);
      if (width != w || height != h) _invalid('Invalid JPEG dimensions');
      if (s.dict['SMask'] != null || s.dict['Decode'] != null) {
        id = assets.png(jpegRaster(s, b, w, h, page), w, h);
      } else {
        id = assets.add(b, 'image/jpeg', 'jpg', w, h);
      }
    } else if (kind == 'CCITTFaxDecode' || kind == 'CCF') {
      id = assets.png(raster(s, faxImage(s, b, w, h), w, h, page), w, h);
    } else if (kind == 'JPXDecode') {
      _unsupported('JPEG 2000 images require an unsupported decoder');
    } else if (kind.isEmpty) {
      id = assets.png(raster(s, b, w, h, page), w, h);
    } else {
      _unsupported('unsupported image encoding $kind');
    }
    p.assetIDs[s] = id;
    return id;
  }

  Uint8List faxImage(_Stream s, Uint8List b, int w, int h) {
    final params = p.array(s.dict['DecodeParms']),
        d = p.dict(params.isNotEmpty ? params.last : s.dict['DecodeParms']),
        columns = d.containsKey('Columns')
            ? _integer(p.resolve(d['Columns']))
            : 1728,
        rows = _integer(p.resolve(d['Rows']));
    if (columns != w || rows != 0 && rows != h) _invalid('CCITT dimensions');
    final out = _decodeFax(
      b,
      w,
      h,
      _integer(p.resolve(d['K'])),
      p.resolve(d['EndOfLine']) == true,
      p.resolve(d['EncodedByteAlign']) == true,
      p.limits.decodedBytes - p.decodedSize,
      p.check,
    );
    p.decodedSize += out.length + 16 * (w + 2);
    if (p.resolve(d['BlackIs1']) != true)
      for (var j = 0; j < out.length; j++) out[j] ^= 255;
    return out;
  }

  int baseColor(Object? v, int page) {
    v = p.resolve(v);
    var kind = _named(v);
    final a = _asArray(v);
    if (a.isNotEmpty) {
      kind = _named(p.resolve(a[0]));
      if (kind == 'ICCBased') {
        if (a.length < 2) _invalid();
        final n = _integer(p.resolve(p.dict(a[1])['N']));
        if (!const [1, 3, 4].contains(n)) _invalid();
        p.warn(
          'icc-profile',
          page,
          'Embedded image ICC profiles are approximated in device color space.',
        );
        return n;
      }
      if (kind == 'CalGray') {
        p.warn(
          'color-space',
          page,
          'Calibrated grayscale image colors are approximated in device color space.',
        );
        return 1;
      }
      if (kind == 'CalRGB') {
        p.warn(
          'color-space',
          page,
          'Calibrated RGB image colors are approximated in device color space.',
        );
        return 3;
      }
    }
    if (const ['DeviceGray', 'G'].contains(kind)) return 1;
    if (const ['DeviceRGB', 'RGB'].contains(kind)) return 3;
    if (const ['DeviceCMYK', 'CMYK'].contains(kind)) return 4;
    return _unsupported('unsupported indexed image base color space $kind');
  }

  Uint8List raster(_Stream s, Uint8List b, int w, int h, int page) {
    final mask = s.dict['ImageMask'] == true,
        bits = mask ? 1 : _integer(p.resolve(s.dict['BitsPerComponent']));
    if (!const [1, 2, 4, 8, 16].contains(bits))
      _unsupported('unsupported image bit depth $bits');
    final cs = p.resolve(s.dict['ColorSpace']);
    var kind = _named(cs),
        palette = Uint8List(0),
        indexed = false,
        high = 255,
        channels = 1;
    final a = _asArray(cs);
    if (a.isNotEmpty) {
      kind = _named(a[0]);
      if (kind == 'ICCBased') {
        if (a.length > 1)
          kind =
              const {1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK'}[_integer(
                p.dict(a[1])['N'],
              )] ??
              kind;
        p.warn(
          'icc-profile',
          page,
          'Embedded image ICC profiles are approximated in device color space.',
        );
      } else if (kind == 'Indexed' || kind == 'I') {
        if (a.length < 4) _invalid();
        final base = baseColor(a[1], page);
        indexed = true;
        high = _integer(p.resolve(a[2]));
        if (bits > 8 || high < 0 || high > 255) _invalid();
        final v = p.resolve(a[3]),
            data = v is _Literal
                ? v.bytes
                : v is _Stream
                ? p.decode(v)
                : Uint8List(0);
        if (data.length < (high + 1) * base) _invalid();
        palette = Uint8List((high + 1) * 3);
        for (var j = 0; j <= high; j++) {
          final at = j * base;
          palette.setRange(
            j * 3,
            j * 3 + 3,
            base == 1
                ? [data[at], data[at], data[at]]
                : base == 3
                ? _slice(data, at, at + 3)
                : _cmykRGB(data[at], data[at + 1], data[at + 2], data[at + 3]),
          );
        }
      } else if (kind == 'CalRGB') {
        kind = 'DeviceRGB';
      } else if (kind == 'CalGray') {
        kind = 'DeviceGray';
      }
    }
    if (mask) {
      kind = 'DeviceGray';
      p.warn(
        'image-stencil',
        page,
        'A stencil image is preserved as grayscale.',
      );
    }
    if (const ['DeviceRGB', 'RGB'].contains(kind)) {
      channels = 3;
    } else if (const ['DeviceCMYK', 'CMYK'].contains(kind)) {
      channels = 4;
    } else if (!const ['DeviceGray', 'G', 'Indexed', 'I'].contains(kind)) {
      _unsupported(
        kind.isEmpty
            ? 'image is missing its color space'
            : 'unsupported image color space $kind',
      );
    }
    final row = (w * channels * bits + 7) ~/ 8;
    if (h > b.length / row) _invalid('truncated image');
    budget(w * h * 4);
    final out = Uint8List(w * h * 4), decode = p.array(s.dict['Decode']);
    // Fast path avoids allocating a temporary color list for every RGB pixel.
    if (bits == 8 && !indexed && decode.isEmpty && channels != 4) {
      for (var y = 0; y < h; y++) {
        if (y % 128 == 0) p.check();
        for (var x = 0; x < w; x++) {
          final source = (y * w + x) * channels, target = (y * w + x) * 4;
          out[target] = b[source];
          out[target + 1] = b[source + (channels == 3 ? 1 : 0)];
          out[target + 2] = b[source + (channels == 3 ? 2 : 0)];
          out[target + 3] = 255;
        }
      }
      softMask(s, out, w, h, page);
      return out;
    }
    int sample(int y, int index) {
      final bit = index * bits, offset = y * row + bit ~/ 8;
      var v = 0;
      if (bits >= 8) {
        v = b[offset];
      } else {
        final mask = (1 << bits) - 1;
        v = (b[offset] >> (8 - bits - bit % 8)) & mask;
        if (!indexed) v = v * 255 ~/ mask;
      }
      final c = index % channels;
      if (indexed) {
        if (decode.length >= 2)
          v =
              (_number(decode[0]) +
                      v /
                          ((1 << bits) - 1) *
                          (_number(decode[1]) - _number(decode[0])))
                  .round();
        return v.clamp(0, high);
      }
      if (decode.length >= 2 * channels)
        v =
            ((_number(decode[2 * c]) +
                        v /
                            255 *
                            (_number(decode[2 * c + 1]) -
                                _number(decode[2 * c]))) *
                    255)
                .truncate()
                .clamp(0, 255);
      return v;
    }

    for (var y = 0; y < h; y++) {
      if (y % 128 == 0) p.check();
      for (var x = 0; x < w; x++) {
        final at = (y * w + x) * 4, v = sample(y, x * channels);
        late List<int> rgb;
        if (channels == 1) {
          rgb = indexed ? _slice(palette, v * 3, v * 3 + 3) : [v, v, v];
        } else if (channels == 3) {
          rgb = [v, sample(y, x * 3 + 1), sample(y, x * 3 + 2)];
        } else {
          rgb = _cmykRGB(
            v,
            sample(y, x * 4 + 1),
            sample(y, x * 4 + 2),
            sample(y, x * 4 + 3),
          );
        }
        out.setRange(at, at + 3, rgb);
        out[at + 3] = 255;
      }
    }
    softMask(s, out, w, h, page);
    return out;
  }

  Uint8List jpegRaster(_Stream s, Uint8List b, int w, int h, int page) {
    final out = jpeg(b, w, h), decode = p.array(s.dict['Decode']);
    int map(int v, int component) =>
        ((_number(decode[component * 2]) +
                    v /
                        255 *
                        (_number(decode[component * 2 + 1]) -
                            _number(decode[component * 2]))) *
                255)
            .clamp(0, 255)
            .round();
    if (!const [0, 2, 6, 8].contains(decode.length))
      _unsupported('unsupported JPEG Decode array');
    for (var y = 0; y < h; y++) {
      if (y % 128 == 0) p.check();
      for (var x = 0; x < w; x++) {
        final at = (y * w + x) * 4,
            r = out[at],
            g = out[at + 1],
            b = out[at + 2];
        if (decode.length == 2) {
          out[at] = out[at + 1] = out[at + 2] = map(_gray(r, g, b), 0);
        } else if (decode.length == 6) {
          out[at] = map(r, 0);
          out[at + 1] = map(g, 1);
          out[at + 2] = map(b, 2);
        } else if (decode.length == 8) {
          final max = math.max(r, math.max(g, b)),
              c = max > 0 ? (max - r) * 255 ~/ max : 0,
              m = max > 0 ? (max - g) * 255 ~/ max : 0,
              yy = max > 0 ? (max - b) * 255 ~/ max : 0;
          out.setRange(
            at,
            at + 3,
            _cmykRGB(map(c, 0), map(m, 1), map(yy, 2), map(255 - max, 3)),
          );
        }
      }
    }
    softMask(s, out, w, h, page);
    return out;
  }

  Uint8List maskSamples(_Stream s, int w, int h) {
    final bits = _integer(p.resolve(s.dict['BitsPerComponent']));
    if (!const [1, 2, 4, 8, 16].contains(bits))
      _unsupported('unsupported soft mask bit depth $bits');
    var (b, kind) = p.decodeFilters(s);
    if (kind == 'CCITTFaxDecode' || kind == 'CCF') {
      b = faxImage(s, b, w, h);
      kind = '';
    }
    if (kind == 'DCTDecode' || kind == 'DCT') {
      final pixels = jpeg(b, w, h), out = Uint8List(w * h);
      for (var y = 0; y < h; y++) {
        p.check();
        for (var x = 0; x < w; x++) {
          final at = (y * w + x) * 4;
          out[y * w + x] = _gray(pixels[at], pixels[at + 1], pixels[at + 2]);
        }
      }
      return out;
    }
    if (kind.isNotEmpty) _unsupported('unsupported soft mask encoding $kind');
    final stride = (w * bits + 7) ~/ 8;
    if (h > b.length / stride) _invalid();
    if (bits == 8) return _slice(b, 0, w * h);
    budget(w * h);
    final out = Uint8List(w * h);
    for (var y = 0; y < h; y++) {
      p.check();
      for (var x = 0; x < w; x++) {
        final at = y * stride + x * bits ~/ 8, mask = (1 << bits) - 1;
        out[y * w + x] = bits == 16
            ? b[at]
            : ((b[at] >> (8 - bits - x * bits % 8)) & mask) * (255 ~/ mask);
      }
    }
    return out;
  }

  void softMask(_Stream s, Uint8List out, int w, int h, int page) {
    final sm = p.resolve(s.dict['SMask']);
    if (sm is _Stream) {
      final mw = _integer(p.resolve(sm.dict['Width'])),
          mh = _integer(p.resolve(sm.dict['Height']));
      if (mw < 1 || mh < 1 || mw > p.limits.imagePixels / mh) _limit();
      if (sm.dict['Matte'] != null) {
        if (mw != w || mh != h)
          _unsupported('matte soft mask dimensions must match the image');
        p.warn(
          'image-matte',
          page,
          'Soft-mask matte colors are not unblended; edge colors need visual review.',
        );
      }
      final alpha = maskSamples(sm, mw, mh),
          decode = p.array(sm.dict['Decode']),
          interpolate = sm.dict['Interpolate'] == true;
      if (alpha.length < mw * mh) _invalid();
      for (var y = 0; y < h; y++) {
        if (y % 128 == 0) p.check();
        for (var x = 0; x < w; x++) {
          final sy = (2 * y + 1) * mh ~/ (2 * h),
              sx = (2 * x + 1) * mw ~/ (2 * w);
          var a = alpha[sy * mw + sx] / 255;
          if (interpolate && (mw != w || mh != h)) {
            final fx = (x + .5) * mw / w - .5,
                fy = (y + .5) * mh / h - .5,
                x0 = fx.floor(),
                y0 = fy.floor(),
                tx = fx - x0,
                ty = fy - y0;
            double at(int xx, int yy) =>
                alpha[yy.clamp(0, mh - 1) * mw + xx.clamp(0, mw - 1)] / 255;
            a =
                (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
                (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
          }
          if (decode.length == 2)
            a =
                _number(decode[0]) +
                a * (_number(decode[1]) - _number(decode[0]));
          out[(y * w + x) * 4 + 3] = (a.clamp(0, 1) * 255).round();
        }
      }
    }
    if (s.dict['Mask'] != null)
      p.warn(
        'image-mask',
        page,
        'Color-key or explicit image masks are not applied.',
      );
  }

  @override
  void inline(_Interpreter i, _Lexer l) {
    final d = <String, Object?>{};
    const aliases = {
      'W': 'Width',
      'H': 'Height',
      'BPC': 'BitsPerComponent',
      'CS': 'ColorSpace',
      'F': 'Filter',
      'DP': 'DecodeParms',
      'D': 'Decode',
      'IM': 'ImageMask',
      'I': 'Interpolate',
    };
    for (var n = 0; n < 100; n++) {
      final v = l.value();
      if (v is _Keyword && v.value == 'ID') break;
      if (v is! _Name) _invalid('inline image dictionary');
      d[aliases[v.value] ?? v.value] = l.value();
      if (n == 99) _limit();
    }
    if (l.pos >= l.data.length || !_white(l.data[l.pos])) _invalid();
    if (l.data[l.pos] == 13 && l.at(l.pos + 1) == 10) l.pos++;
    l.pos++;
    final cs = _named(d['ColorSpace']);
    if (cs.isNotEmpty) {
      final v = p.dict(i.resources['ColorSpace'])[cs];
      if (v != null) d['ColorSpace'] = v;
    }
    final start = l.pos,
        tail = _slice(l.data, start),
        filters = _asArray(d['Filter']),
        filter = _named(filters.isNotEmpty ? filters[0] : d['Filter']);
    var length = 0;
    if (filter.isEmpty) {
      final w = _integer(d['Width']),
          h = _integer(d['Height']),
          bits = d['ImageMask'] == true ? 1 : _integer(d['BitsPerComponent']),
          color = p.resolve(d['ColorSpace']),
          array = _asArray(color),
          kind = _named(array.isNotEmpty ? p.resolve(array[0]) : color);
      var channels = const ['RGB', 'DeviceRGB', 'CalRGB', 'Lab'].contains(kind)
          ? 3
          : const ['CMYK', 'DeviceCMYK'].contains(kind)
          ? 4
          : 1;
      if (kind == 'ICCBased')
        channels = _integer(p.dict(array.length > 1 ? array[1] : null)['N']);
      if (d['ImageMask'] == true) channels = 1;
      if (!const [1, 3, 4].contains(channels))
        _invalid('Inline image color components');
      if (w < 1 ||
          h < 1 ||
          bits < 1 ||
          bits > 16 ||
          w > p.limits.imagePixels / h)
        _limit();
      length = ((w * channels * bits + 7) ~/ 8) * h;
    } else if (filter == 'Fl' || filter == 'FlateDecode') {
      length = _inflateMember(tail, p.limits.decodedBytes - p.decodedSize).$2;
    } else {
      var first = 0, last = 0;
      if (filter == 'A85' || filter == 'ASCII85Decode') {
        first = 126;
        last = 62;
      } else if (filter == 'AHx' || filter == 'ASCIIHexDecode') {
        first = 62;
      } else if (filter == 'DCT' || filter == 'DCTDecode') {
        first = 255;
        last = 217;
      } else {
        _unsupported('unsupported inline image filter $filter');
      }
      var end = -1;
      for (var at = 0; at < tail.length; at++)
        if (tail[at] == first &&
            (last == 0 || at + 1 < tail.length && tail[at + 1] == last)) {
          end = at;
          break;
        }
      if (end < 0) _invalid();
      length = end + (last != 0 ? 2 : 1);
    }
    if (length < 0 || length > tail.length) _invalid();
    l.pos = start + length;
    if (l.word() != 'EI') _invalid('inline image terminator');
    try {
      final id = image(_Stream(d, _slice(tail, 0, length)), i.page.page.number),
          box = _rect(i.g.ctm, 0, 0, 1, 1);
      _finiteRect(box);
      i.page.images.add(
        Block(kind: 'image', asset: id, alt: 'Image', box: box),
      );
    } catch (e) {
      i.imageError(e);
    }
  }
}
