part of pdf_extractor;

String _escapeMD(String s) => s.replaceAllMapped(
  RegExp(r'[\\`*_\[\]<>|]'),
  (m) => m[0] == '<'
      ? '&lt;'
      : m[0] == '>'
      ? '&gt;'
      : '\\${m[0]}',
);
String _markdownRuns(Block b) {
  if (b.runs.isEmpty) return _escapeMD(b.text);
  final out = StringBuffer();
  for (final r in b.runs) {
    if (r.asset.isNotEmpty) {
      out.write('![${_escapeMD(r.text)}](${r.asset})');
      continue;
    }
    var t = _escapeMD(r.text), prefix = '', suffix = '';
    if (RegExp(r'^\s').hasMatch(t)) {
      prefix = ' ';
      t = t.replaceFirst(RegExp(r'^ +'), '');
    }
    if (t.endsWith(' ')) {
      suffix = ' ';
      t = t.replaceFirst(RegExp(r' +$'), '');
    }
    if (r.script == 'sup' || r.script == 'sub')
      t = '<${r.script}>$t</${r.script}>';
    if (r.bold && b.kind != 'heading') t = '**$t**';
    if (r.italic) t = '*$t*';
    if (_safeLink(r.link))
      t = '[$t](${r.link.replaceAllMapped(RegExp('[() \n]'), (m) => const {'(': '%28', ')': '%29', ' ': '%20', '\n': '%0A'}[m[0]]!)})';
    out.write(prefix + t + suffix);
  }
  return out.toString().trim();
}

String _htmlRuns(String text, List<Run> runs, [String kind = '']) {
  if (runs.isEmpty) return _xmlText(text);
  final out = StringBuffer();
  for (final r in runs) {
    if (r.asset.isNotEmpty) {
      out.write(
        '<img class="math-inline" data-math-representation="positioned" data-math-monochrome="${r.monochrome}" src="${_xmlText(r.asset)}" alt="${_xmlText(r.text)}" style="height:${r.heightEm.toStringAsFixed(4)}em;vertical-align:-${r.depthEm.toStringAsFixed(4)}em"/>',
      );
      continue;
    }
    var t = _xmlText(r.text);
    if (r.script == 'sup' || r.script == 'sub')
      t = '<${r.script}>$t</${r.script}>';
    if (r.bold && kind != 'heading') t = '<strong>$t</strong>';
    if (r.italic) t = '<em>$t</em>';
    if (_safeLink(r.link)) t = '<a href="${_xmlText(r.link)}">$t</a>';
    out.write(t);
  }
  return out.toString();
}

bool _complexTable(Table? t) =>
    t != null &&
    (t.headerRows > 1 || t.cells.any((c) => c.rowSpan > 1 || c.colSpan > 1));
String _tableHTML(Block b, String prefix) {
  var t = b.table;
  if (t == null) {
    t = Table(
      rows: b.rows.length,
      columns: 0,
      headerRows: math.min(1, b.rows.length),
    );
    for (var r = 0; r < b.rows.length; r++) {
      final row = b.rows[r];
      t.columns = math.max(t.columns, row.length);
      for (var col = 0; col < row.length; col++)
        t.cells.add(
          TableCell(
            row: r,
            column: col,
            text: row[col],
            header: r == 0,
            box: const Rect(0, 0, 0, 0),
          ),
        );
    }
  }
  final headers = t.headerRows,
      byRow = <int, List<TableCell>>{},
      columns = <int, List<String>>{},
      rows = <int, List<String>>{};
  for (final c in t.cells) {
    byRow.putIfAbsent(c.row, () => []).add(c);
    if (!c.header || c.text.isEmpty) continue;
    final id = '$prefix-r${c.row}-c${c.column}';
    if (c.row < headers) {
      for (
        var col = math.max(0, c.column);
        col < math.min(t.columns, c.column + c.colSpan);
        col++
      )
        columns.putIfAbsent(col, () => []).add(id);
    } else if (c.scope == 'row' || c.scope == 'rowgroup') {
      for (
        var row = math.max(0, c.row);
        row < math.min(t.rows, c.row + c.rowSpan);
        row++
      )
        rows.putIfAbsent(row, () => []).add(id);
    }
  }
  final proposed = <int>{}, cuts = <int>{};
  for (final c in t.cells)
    if (c.header && c.scope == 'rowgroup') {
      proposed.add(c.row);
      proposed.add(c.row + c.rowSpan);
    }
  var activeEnd = headers;
  for (var r = headers; r < t.rows; r++) {
    if (r > headers && proposed.contains(r) && activeEnd <= r) cuts.add(r);
    for (final c in byRow[r] ?? <TableCell>[])
      activeEnd = math.max(activeEnd, c.row + c.rowSpan);
  }
  final out = StringBuffer(
    '<table>\n${headers > 0 ? '<thead>\n' : '<tbody>\n'}',
  );
  for (var r = 0; r < t.rows; r++) {
    if (r == headers && r > 0) out.write('</thead>\n<tbody>\n');
    if (cuts.contains(r)) out.write('</tbody>\n<tbody>\n');
    out.write('<tr>');
    final cells = byRow[r] ?? <TableCell>[];
    _stableSort(cells, (a, b) => a.column.compareTo(b.column));
    for (final c in cells) {
      final tag = c.header ? 'th' : 'td';
      out.write('<$tag');
      if (c.rowSpan > 1) out.write(' rowspan="${c.rowSpan}"');
      if (c.colSpan > 1) out.write(' colspan="${c.colSpan}"');
      if (c.header) {
        out.write(' id="${_xmlText(prefix)}-r${c.row}-c${c.column}"');
        if (['col', 'colgroup', 'row', 'rowgroup'].contains(c.scope))
          out.write(' scope="${c.scope}"');
      } else {
        final ids = <String>{};
        for (
          var col = math.max(0, c.column);
          col < math.min(t.columns, c.column + c.colSpan);
          col++
        )
          ids.addAll(columns[col] ?? []);
        for (
          var row = math.max(0, c.row);
          row < math.min(t.rows, c.row + c.rowSpan);
          row++
        )
          ids.addAll(rows[row] ?? []);
        if (ids.isNotEmpty) out.write(' headers="${_xmlText(ids.join(' '))}"');
      }
      out.write('>${_htmlRuns(c.text, c.runs)}</$tag>');
    }
    out.write('</tr>\n');
  }
  out.write(
    '${headers >= t.rows && headers > 0 ? '</thead>\n' : '</tbody>\n'}</table>',
  );
  return out.toString();
}

/// Renders the structured blocks as Markdown, preserving complex tables as HTML.
String markdown(Document d) {
  final out = StringBuffer(
    d.warnings.isNotEmpty
        ? "> Extraction notes: this document contains features that need review. See the structured warnings or the reading edition's extraction notes.\n\n"
        : '',
  );
  for (final page in d.pages) {
    out.write('<a id="page-${page.number}"></a>\n\n');
    for (var bi = 0; bi < page.blocks.length; bi++) {
      final b = page.blocks[bi], text = b.text;
      if (b.kind == 'heading') {
        out.write(
          '${'#' * math.max(1, math.min(6, b.level))} ${_markdownRuns(b)}\n\n',
        );
      } else if (b.kind == 'code') {
        var fence = '```';
        while (text.contains(fence)) fence += '`';
        out.write('$fence${b.language}\n$text\n$fence\n\n');
      } else if (b.kind == 'list') {
        final trimmed = text.trim(),
            t = RegExp('^[•●▪]').hasMatch(trimmed)
                ? _escapeMD(trimmed.substring(1)).trim()
                : _markdownRuns(b);
        out.write('- $t\n\n');
      } else if (b.kind == 'table') {
        if (_complexTable(b.table)) {
          out.write('${_tableHTML(b, 'table-${page.number}-$bi')}\n\n');
        } else {
          for (var j = 0; j < b.rows.length; j++) {
            final row = b.rows[j];
            out.write(
              '| ${row.map((c) => _escapeMD(c).replaceAll('\n', '<br>')).join(' | ')} |\n',
            );
            if (j == 0) out.write('|${' --- |' * row.length}\n');
          }
          out.write('\n');
        }
      } else if (b.kind == 'image' || b.kind == 'math') {
        out.write('![${_escapeMD(b.alt)}](${b.asset})\n\n');
      } else {
        out.write('${_markdownRuns(b)}\n\n');
      }
    }
  }
  return '${out.toString().trim()}\n';
}

String pageHTML(Page page) {
  final out = StringBuffer(
    '<section id="page-${page.number}" aria-label="Page ${page.number}">',
  );
  for (var j = 0; j < page.blocks.length; j++) {
    final b = page.blocks[j];
    if (b.kind == 'heading') {
      final level = math.max(1, math.min(6, b.level));
      out.write(
        '<h$level id="b-$j">${_htmlRuns(b.text, b.runs, b.kind)}</h$level>',
      );
    } else if (b.kind == 'code') {
      out.write(
        '<pre><code class="language-${_xmlText(b.language)}">${_xmlText(b.text)}</code></pre>',
      );
    } else if (b.kind == 'math') {
      out.write(
        '<figure class="math-display"><img data-math-representation="positioned" data-math-monochrome="${b.monochrome}" src="${_xmlText(b.asset)}" alt="${_xmlText(b.text)}" style="--pdf-math-width:${b.widthEm.toStringAsFixed(4)}em;width:${b.widthEm.toStringAsFixed(4)}em;max-width:100%;height:auto"/></figure>',
      );
    } else if (b.kind == 'image') {
      out.write(
        '<figure><img src="${_xmlText(b.asset)}" alt="${_xmlText(b.alt)}"/></figure>',
      );
    } else if (b.kind == 'table') {
      out.write(_tableHTML(b, 'table-${page.number}-$j'));
    } else if (b.kind == 'list') {
      out.write(
        '<p class="list-item">${_htmlRuns(b.text, b.runs, b.kind)}</p>',
      );
    } else {
      out.write(
        '<p class="${_xmlText(b.role)}">${_htmlRuns(b.text, b.runs, b.kind)}</p>',
      );
    }
  }
  out.write('</section>');
  return out.toString();
}

String _xhtml(String title, String body) =>
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${_xmlText(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>$body</body></html>';

/// Builds a deterministic, self-contained EPUB reading edition.
Uint8List epub(Document d) {
  final files = archive.Archive();
  void add(String name, Object value, {bool stored = false}) {
    final bytes = value is String ? utf8.encode(value) : value as Uint8List;
    final file = archive.ArchiveFile(name, bytes.length, bytes)
      ..lastModTime = DateTime.utc(2000).millisecondsSinceEpoch ~/ 1000;
    if (stored) file.compression = archive.CompressionType.none;
    files.add(file);
  }

  add('mimetype', 'application/epub+zip', stored: true);
  add(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  var manifest =
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>',
      spine = '',
      toc = '';
  if (d.warnings.isNotEmpty) {
    var body =
        '<h1>About this reading edition</h1><p>PDF Extractor recovered the available content and converted it into reflowable blocks. Some source features need review. These notes describe known gaps; the absence of a note is not an accuracy guarantee.</p><ul>';
    final messages = <String, List<int>>{};
    for (final w in d.warnings) {
      final pages = messages.putIfAbsent(w.message, () => []);
      if (w.page > 0) pages.add(w.page);
    }
    for (final e in messages.entries) {
      final pages = e.value,
          where = pages.length == 1
              ? ' (page ${pages.first})'
              : pages.length > 1
              ? ' (${pages.length} page reports; details in the structured output)'
              : '';
      body += '<li>${_xmlText(e.key + where)}</li>';
    }
    body += '</ul>';
    add('OEBPS/notes.xhtml', _xhtml('Extraction notes', body));
    manifest +=
        '<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>';
    spine += '<itemref idref="notes"/>';
    toc += '<li><a href="notes.xhtml">Extraction notes</a></li>';
  }
  for (final page in d.pages) {
    final file = 'page-${page.number}.xhtml',
        id = 'p${page.number}',
        hasSVG = page.blocks.any(
          (b) =>
              b.asset.endsWith('.svg') ||
              b.runs.any((r) => r.asset.endsWith('.svg')),
        );
    manifest +=
        '<item id="$id" href="$file" media-type="application/xhtml+xml"${hasSVG ? ' properties="svg"' : ''}/>';
    spine += '<itemref idref="$id"/>';
    add('OEBPS/$file', _xhtml(d.title, pageHTML(page)));
    var found = false;
    for (var j = 0; j < page.blocks.length; j++) {
      final b = page.blocks[j];
      if (b.kind == 'heading') {
        toc += '<li><a href="$file#b-$j">${_xmlText(b.text)}</a></li>';
        found = true;
      }
    }
    if (!found) toc += '<li><a href="$file">Page ${page.number}</a></li>';
  }
  for (var j = 0; j < d.assets.length; j++) {
    final a = d.assets[j];
    if (!a.name.startsWith('assets/') ||
        a.name.contains('..') ||
        RegExp(r'[\\\x00]').hasMatch(a.name))
      _invalid('Unsafe asset name');
    add('OEBPS/${a.name}', a.data);
    manifest +=
        '<item id="a$j" href="${_xmlText(a.name)}" media-type="${_xmlText(a.mediaType)}"/>';
  }
  add(
    'OEBPS/nav.xhtml',
    _xhtml(
      'Contents',
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>$toc</ol></nav>',
    ),
  );
  add(
    'OEBPS/style.css',
    'body { line-height:1.6; } .math-inline { display:inline; width:auto; max-width:none; margin:0; } .math-display { text-align:center; overflow-x:auto; } .math-display img { width:auto; max-width:100%; } sup,sub { font-size:.7em; line-height:0; } img,svg { max-width:100%; height:auto; } table { border-collapse:collapse; width:100%; margin:1em 0; } td,th { border:1px solid currentColor; padding:.4em .65em; text-align:left; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; padding:1em; } figure { margin:1.4em 0; } .caption,.footnote { font-size:.9em; } .caption { font-style:italic; } .list-item { padding-left:1em; } h1,h2,h3 { line-height:1.3; }',
  );
  final language =
          d.language.isEmpty || RegExp(r'[ <>\n\t]').hasMatch(d.language)
          ? 'en'
          : d.language,
      metadata =
          '<dc:identifier id="id">urn:sha256:${_xmlText(d.sha256)}</dc:identifier><dc:title>${_xmlText(d.title)}</dc:title><dc:creator>${_xmlText(d.author)}</dc:creator><dc:language>${_xmlText(language)}</dc:language><dc:description>${_xmlText(d.subject)}</dc:description><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>';
  add(
    'OEBPS/package.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">$metadata</metadata><manifest>$manifest</manifest><spine>$spine</spine></package>',
  );
  return archive.ZipEncoder().encodeBytes(files, level: 1);
}
