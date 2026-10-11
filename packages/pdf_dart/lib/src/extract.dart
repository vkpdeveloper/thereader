part of pdf_extractor;

/// Extracts PDF bytes entirely in Dart, with no filesystem, JS bridge or server.
Document extract(Uint8List data, {Options options = const Options()}) {
  final started = Stopwatch()..start(),
      p = _PDF(data, options),
      root = p.dict(p.trailer['Root']);
  if (_named(root['Type']) != 'Catalog') _invalid('missing catalog');
  final info = p.dict(p.trailer['Info']), out = p.out;
  out.title = _textString(info['Title']);
  out.author = _textString(info['Author']);
  out.subject = _textString(info['Subject']);
  out.keywords = _textString(info['Keywords']);
  out.creator = _textString(info['Creator']);
  out.created = _textString(info['CreationDate']);
  out.language = _textString(root['Lang']);
  _xmp(p, root['Metadata']);
  out.sha256 = crypto.sha256.convert(data).toString();
  if (out.language.isEmpty) out.language = 'en';
  if (root['AcroForm'] != null)
    p.warn(
      'forms',
      0,
      'Interactive form field values are not included in the reading edition.',
    );
  if (p.dict(root['Names'])['EmbeddedFiles'] != null)
    p.warn(
      'attachments',
      0,
      'Embedded attachments are not included in the reading edition.',
    );
  if (root['OCProperties'] != null)
    p.warn(
      'optional-content',
      0,
      'Optional layer visibility is not evaluated.',
    );
  final (tags, alts) = _structure(p, root['StructTreeRoot']);
  final pages = <_PageContent>[],
      seen = <_Ref>{},
      fonts = _Fonts(p),
      programs = _FontPrograms(p, fonts),
      assets = _Assets(p),
      images = _Images(p, assets),
      positioned = _PositionedGraphics(p, programs, assets);
  void walk(Object? v, _Dict inherited, int depth) {
    p.check();
    if (depth > 64) _limit();
    final ref = v is _Ref ? v : null;
    if (ref != null && !seen.add(ref)) _invalid('cyclic page tree');
    final d = p.dict(v), props = _Dict.of(inherited);
    for (final k in ['Resources', 'MediaBox', 'CropBox', 'Rotate'])
      if (d.containsKey(k)) props[k] = d[k];
    if (_named(d['Type']) == 'Pages') {
      for (final child in p.array(d['Kids'])) walk(child, props, depth + 1);
      return;
    }
    if (_named(d['Type']) != 'Page') _invalid('expected page');
    if (pages.length >= p.limits.pages) _limit();
    var box = p.array(props['CropBox']);
    if (box.length != 4) box = p.array(props['MediaBox']);
    if (box.length != 4) _invalid('missing MediaBox');
    var x0 = _number(box[0]),
        y0 = _number(box[1]),
        x1 = _number(box[2]),
        y1 = _number(box[3]);
    final media = p.array(props['MediaBox']);
    if (media.length == 4) {
      x0 = math.max(x0, _number(media[0]));
      y0 = math.max(y0, _number(media[1]));
      x1 = math.min(x1, _number(media[2]));
      y1 = math.min(y1, _number(media[3]));
    }
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || w > 1000000 || h > 1000000)
      _invalid('page dimensions');
    final rotation = (_integer(p.resolve(props['Rotate'])) % 360 + 360) % 360;
    _Matrix base = [1, 0, 0, -1, -x0, y1];
    if (rotation == 90) {
      base = [0, 1, 1, 0, -y0, -x0];
      (w, h) = (h, w);
    } else if (rotation == 180) {
      base = [-1, 0, 0, 1, x1, -y0];
    } else if (rotation == 270) {
      base = [0, -1, -1, 0, y1, x1];
      (w, h) = (h, w);
    } else if (rotation != 0) {
      _invalid('invalid page rotation');
    }
    final pc = _PageContent(
      Page(number: pages.length + 1, width: w, height: h),
      id: ref,
      tags: tags[ref?.id ?? 0],
      alt: alts[ref?.id ?? 0],
    );
    if (_number(d['UserUnit']) > 1)
      p.warn(
        'user-unit',
        pc.page.number,
        'Page coordinates use unscaled PDF user units.',
      );
    final interpreter = _Interpreter(
          p,
          pc,
          _Graphics(base),
          p.dict(props['Resources']),
          fonts,
          images,
        ),
        contents = p.resolve(d['Contents']),
        streams = contents is _Stream ? [contents] : _asArray(contents);
    for (final v in streams) {
      final s = p.resolve(v);
      if (s is! _Stream) {
        p.warn(
          'content-stream',
          pc.page.number,
          'Page content stream is missing.',
        );
        continue;
      }
      try {
        interpreter.run(p.decode(s));
      } catch (e) {
        if (e is PdfException &&
            (e.code == 'RESOURCE_LIMIT' || e.code == 'ABORTED'))
          rethrow;
        p.warn(
          'content-stream',
          pc.page.number,
          e is PdfException ? e.message : e.toString(),
        );
      }
    }
    pc.spans = _deduplicateSpans(pc.spans);
    _pageLinks(p, pc, d, base);
    pages.add(pc);
    p.check();
  }

  walk(root['Pages'], {}, 0);
  if (pages.isEmpty) _invalid('no pages');
  if (!options.keepArtifacts) _cleanMargins(pages);
  final body = _bodyFontSize(pages);
  for (final pc in pages) {
    p.check();
    pc.page.blocks = _layout(pc, body, positioned);
    if (pc.spans.isEmpty && pc.images.isNotEmpty) {
      pc.page.needsOCR = true;
      p.warn(
        'needs-ocr',
        pc.page.number,
        'This page contains images without a text layer. The images are preserved; OCR has not been performed.',
      );
    }
    for (final b in pc.page.blocks) {
      out.stats.characters += _runeCount(b.text);
      for (final row in b.rows)
        for (final cell in row) out.stats.characters += _runeCount(cell);
      if (b.kind == 'image') {
        out.stats.images++;
      } else if (b.kind == 'table') {
        out.stats.tables++;
      } else if (b.kind == 'math') {
        out.stats.math++;
      } else if (b.kind == 'heading') {
        out.stats.headings++;
      }
    }
    out.pages.add(pc.page);
  }
  _outlines(p, root['Outlines'], pages);
  if (out.title.trim().isEmpty)
    for (final page in out.pages) {
      final heading = page.blocks.where((b) => b.kind == 'heading').firstOrNull;
      if (heading != null) {
        out.title = heading.text;
        if (out.title.isNotEmpty) break;
      }
    }
  if (out.title.isEmpty) out.title = 'Untitled PDF';
  _markSectionRoles(out.pages);
  out.stats.pages = pages.length;
  out.markdown = markdown(out);
  out.stats.durationMs = started.elapsedMicroseconds / 1000;
  p.check();
  return out;
}
