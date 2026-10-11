part of pdf_extractor;

void _xmp(_PDF p, Object? v) {
  final s = p.resolve(v);
  if (s is! _Stream) return;
  late Uint8List data;
  try {
    data = p.decode(s);
  } catch (e) {
    if (e is PdfException &&
        (e.code == 'RESOURCE_LIMIT' || e.code == 'ABORTED'))
      rethrow;
    p.warn('metadata', 0, 'XMP metadata could not be decoded.');
    return;
  }
  if (data.length > 4 * 1048576) {
    p.warn('metadata', 0, 'XMP metadata exceeds the metadata limit.');
    return;
  }
  final values = <String, List<String>>{},
      fields = {
        'title',
        'creator',
        'description',
        'language',
        'subject',
        'Keywords',
        'CreatorTool',
        'CreateDate',
      };
  var message = 'XMP metadata is malformed.';
  try {
    final document = xml.XmlDocument.parse(
      utf8.decode(data, allowMalformed: true),
    );
    void walk(xml.XmlNode node, List<String> stack) {
      if (node is xml.XmlElement) {
        if (stack.length > 64) {
          message = 'XMP metadata nesting exceeds the limit.';
          throw FormatException(message);
        }
        stack = [...stack, node.name.local];
      }
      if (node is xml.XmlText || node is xml.XmlCDATA) {
        final text = node.value?.trim() ?? '';
        if (text.isNotEmpty)
          for (final field in stack)
            if (fields.contains(field))
              values.putIfAbsent(field, () => []).add(text);
      }
      for (final child in node.children) walk(child, stack);
    }

    walk(document, []);
  } catch (_) {
    p.warn('metadata', 0, message);
    return;
  }
  String first(String k) => values[k]?.firstOrNull ?? '';
  final out = p.out;
  if (out.title.isEmpty) out.title = first('title');
  if (out.author.isEmpty) out.author = (values['creator'] ?? []).join('; ');
  if (out.subject.isEmpty) out.subject = first('description');
  if (out.keywords.isEmpty)
    out.keywords = first('Keywords').isNotEmpty
        ? first('Keywords')
        : (values['subject'] ?? []).join(', ');
  if (out.creator.isEmpty) out.creator = first('CreatorTool');
  if (out.created.isEmpty) out.created = first('CreateDate');
  if (out.language.isEmpty) out.language = first('language');
}

(Map<int, Map<int, String>>, Map<int, Map<int, String>>) _structure(
  _PDF p,
  Object? v,
) {
  final tags = <int, Map<int, String>>{},
      alts = <int, Map<int, String>>{},
      root = p.dict(v),
      roles = p.dict(p.dict(v)['RoleMap']),
      seen = <_Ref>{};
  var nodes = 0;
  void walk(Object? v, int pageID, String role, String alt, int depth) {
    if (++nodes > p.limits.objects || depth > 64) _limit();
    if (v is _Ref && !seen.add(v)) return;
    v = p.resolve(v);
    if (v is List) {
      for (final child in v) walk(child, pageID, role, alt, depth + 1);
      return;
    }
    if (v is num) {
      if (pageID != 0) {
        tags.putIfAbsent(pageID, () => {})[v.truncate()] = role;
        alts.putIfAbsent(pageID, () => {})[v.truncate()] = alt;
      }
      return;
    }
    final d = _asDict(v), pg = d['Pg'];
    if (pg is _Ref) pageID = pg.id;
    final n = _named(d['S']);
    if (n.isNotEmpty) role = _named(roles[n]).isNotEmpty ? _named(roles[n]) : n;
    final a = _textString(d['Alt']);
    if (a.isNotEmpty) alt = a;
    if (d.containsKey('MCID')) walk(d['MCID'], pageID, role, alt, depth + 1);
    if (d.containsKey('K')) walk(d['K'], pageID, role, alt, depth + 1);
  }

  walk(root['K'], 0, '', '', 0);
  return (tags, alts);
}

void _outlines(_PDF p, Object? v, List<_PageContent> pages) {
  final pageNumbers = {for (final pc in pages) pc.id?.id ?? 0: pc.page.number},
      seen = <_Ref>{};
  var count = 0;
  void walk(Object? v, int level) {
    while (v != null) {
      if (++count > 10000 || level > 64) {
        p.warn(
          'outline-limit',
          0,
          'The document outline exceeds the traversal limit.',
        );
        return;
      }
      if (v is _Ref && !seen.add(v)) return;
      final d = p.dict(v);
      var dest = p.array(d['Dest']);
      if (dest.isEmpty) dest = p.array(p.dict(d['A'])['D']);
      final ref = dest.firstOrNull,
          page = ref is _Ref ? pageNumbers[ref.id] ?? 0 : 0,
          title = _textString(d['Title']);
      if (title.isNotEmpty) p.out.outline.add(Outline(title, page, level));
      walk(d['First'], level + 1);
      v = d['Next'];
    }
  }

  walk(p.dict(v)['First'], 1);
}

void _markSectionRoles(List<Page> pages) {
  var role = '';
  for (final page in pages)
    for (final b in page.blocks) {
      if (b.kind == 'heading') {
        final title = b.text
            .trim()
            .replaceAll(RegExp(r'^[\d. ]+|[\d. ]+$'), '')
            .toLowerCase();
        if ([
          'references',
          'bibliography',
          'works cited',
          'further reading',
        ].contains(title)) {
          role = 'reference';
        } else if (['index', 'subject index', 'name index'].contains(title)) {
          role = 'index';
        } else if (b.level <= 2) {
          role = '';
        }
      } else if (b.role.isEmpty &&
          (b.kind == 'paragraph' || b.kind == 'list')) {
        b.role = role;
      }
    }
}
