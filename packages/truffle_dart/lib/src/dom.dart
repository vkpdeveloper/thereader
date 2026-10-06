/// `fromDom` for package:html (`tree.ts`): copies a parsed document into a
/// [VDocument]. The only platform-specific stage of the pipeline.
library;

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html_parser;

import 'js.dart';
import 'tree.dart';

/// Elements dropped with their content while copying the DOM.
const _drop = {
  'script', 'style', 'template', 'canvas', 'object', 'embed', 'applet', 'param', //
  'select', 'option', 'optgroup', 'textarea', 'button', 'datalist', 'dialog', 'map', 'area',
  'frame', 'frameset', 'noembed', 'portal', 'slot', 'meter', 'progress', 'output',
};

final _hiddenStyle = RegExp(r'(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)', caseSensitive: false);

/// Screen-reader-only text: never part of what a reader sees.
final _srOnly = RegExp(
  r'(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|screenreader-only|a11y-hidden|hide-for-sr|u-hidden-visually|vh|offscreen|is-hidden|hidden-text)(?:\s|$)',
);
final _decorativeKeep = RegExp(r'fallback-image|lazy|image|img|photo|figure|media', caseSensitive: false);
final _suspenseId = RegExp(r'^S:\d+$');

/// Attribute name as the DOM reports it (`xlink:href` for namespaced ones).
String _attrName(Object key) => key is String ? key : key.toString();

String? _attr(dom.Element el, String name) => el.attributes[name];

bool _isHidden(dom.Element el, String tag) {
  final cls = _attr(el, 'class');
  if (cls != null && cls.contains('mwe-math-mathml')) return false;
  // React streaming SSR parks finished Suspense boundaries in <div hidden id="S:n"> until JS swaps them in.
  if (el.attributes.containsKey('hidden') && tag != 'input' && !_suspenseId.hasMatch(_attr(el, 'id') ?? '')) {
    return true;
  }
  final style = _attr(el, 'style');
  if (style != null && _hiddenStyle.hasMatch(style)) return true;
  if (cls != null && _srOnly.hasMatch(cls)) return true;
  if (_attr(el, 'aria-hidden') == 'true') {
    // KaTeX and MathJax hide their visual copy; the MathML copy is read instead.
    // Decorative wrappers that still hold real images or long text stay.
    return !(cls != null && _decorativeKeep.hasMatch(cls));
  }
  return false;
}

/// `textContent`: the text of every descendant text node.
String _textContent(dom.Node node) {
  final out = StringBuffer();
  void visit(dom.Node n) {
    for (final child in n.nodes) {
      if (child is dom.Text) {
        out.write(child.data);
      } else if (child is dom.Element) {
        visit(child);
      }
    }
  }

  visit(node);
  return out.toString();
}

/// Elements the HTML parser keeps inside a `<noscript>` in `<head>` when
/// scripting is disabled ("in head noscript" insertion mode).
const _headNoscriptContent = {'basefont', 'bgsound', 'link', 'meta', 'noframes', 'style'};

bool _isHtmlSpace(int c) => c == 0x20 || c == 0x0a || c == 0x09 || c == 0x0c || c == 0x0d;

/// The markup inside a `<noscript>`, which package:html parses as raw text
/// (the scripting-enabled rule); null when it already has element children.
List<dom.Node>? _noscriptContent(dom.Element el) {
  final nodes = el.nodes;
  if (nodes.isEmpty) return const [];
  if (nodes.length != 1 || nodes.first is! dom.Text) return null;
  return html_parser.parseFragment((nodes.first as dom.Text).data, container: 'div').nodes.toList();
}

/// Reproduces what a parser with scripting disabled does with a `<noscript>`
/// in `<head>` that holds more than `<link>`, `<meta>` and `<style>` (a
/// tracking pixel, typically): the noscript ends at the first other node,
/// which starts `<body>`, and everything after it in `<head>` becomes body
/// content too.
class _HeadSpill {
  _HeadSpill(this.noscript, this.kept, this.spill);

  final dom.Element noscript;

  /// Children the noscript keeps.
  final List<dom.Node> kept;

  /// Nodes that open `<body>`, before the page's own body content.
  final List<dom.Node> spill;

  static _HeadSpill? find(dom.Element? head) {
    if (head == null) return null;
    final children = head.nodes;
    for (var i = 0; i < children.length; i++) {
      final noscript = children[i];
      if (noscript is! dom.Element || noscript.localName != 'noscript') continue;
      final content = _noscriptContent(noscript);
      if (content == null) continue;
      for (var k = 0; k < content.length; k++) {
        final node = content[k];
        if (node is dom.Comment) continue;
        if (node is dom.Element && _headNoscriptContent.contains(node.localName)) continue;
        final kept = content.sublist(0, k);
        final spill = <dom.Node>[];
        if (node is dom.Text) {
          // Leading whitespace stays in the noscript; the first other character starts the body.
          final data = node.data;
          var j = 0;
          while (j < data.length && _isHtmlSpace(data.codeUnitAt(j))) {
            j++;
          }
          if (j == data.length) continue;
          if (j > 0) kept.add(dom.Text(data.substring(0, j)));
          spill.add(dom.Text(data.substring(j)));
        } else {
          spill.add(node);
        }
        spill.addAll(content.sublist(k + 1));
        spill.addAll(children.sublist(i + 1));
        return _HeadSpill(noscript, kept, spill);
      }
    }
    return null;
  }
}

/// Adjacent text nodes merged, as the parser would have inserted them.
List<dom.Node> _mergeText(Iterable<dom.Node> nodes) {
  final out = <dom.Node>[];
  for (final node in nodes) {
    if (node is dom.Text && out.isNotEmpty && out.last is dom.Text) {
      out[out.length - 1] = dom.Text((out.last as dom.Text).data + node.data);
    } else {
      out.add(node);
    }
  }
  return out;
}

const _cells = {'td', 'th', 'caption'};

bool _inTableCell(dom.Element el) {
  for (var p = el.parent; p != null; p = p.parent) {
    if (_cells.contains(p.localName)) return true;
  }
  return false;
}

/// Copies a package:html document into a [VDocument], producing the tree a
/// spec-compliant parser with scripting disabled (browsers' `DOMParser`,
/// jsdom) yields. package:html parses `<noscript>` as raw text, so its text is
/// parsed again as markup here (with the scripting-disabled `<head>` rules),
/// and it keeps the newline that opens a `<pre>` inside a table cell.
VDocument fromDocument(dom.Document doc) {
  final jsonLd = <String>[];
  String? nextData;
  String? baseHref;
  VElement? head;
  VElement? body;

  final documentElement = doc.documentElement;
  dom.Element? headEl;
  dom.Element? bodyEl;
  for (final child in documentElement?.children ?? const <dom.Element>[]) {
    if (child.localName == 'head') headEl ??= child;
    if (child.localName == 'body') bodyEl ??= child;
  }
  final headSpill = _HeadSpill.find(headEl);

  late VElement? Function(dom.Element el, VElement? parent, bool inHead) copy;

  void copyChildren(List<dom.Node> nodes, VElement v, bool inHead) {
    for (final child in nodes) {
      if (child is dom.Text) {
        final text = child.data;
        if (text.isNotEmpty) v.append(VText(text));
      } else if (child is dom.Element) {
        final c = copy(child, v, inHead);
        if (c != null) v.append(c);
      }
    }
  }

  /// The children the scripting-disabled parse gives [el].
  List<dom.Node> childNodes(dom.Element el, String tag) {
    if (headSpill != null) {
      if (identical(el, headSpill.noscript)) return headSpill.kept;
      if (identical(el, headEl)) {
        final nodes = el.nodes;
        return nodes.sublist(0, nodes.indexOf(headSpill.noscript) + 1);
      }
      if (identical(el, documentElement) && bodyEl != null) {
        // Text between </head> and <body> was body text all along.
        final nodes = el.nodes;
        final from = nodes.indexOf(headEl!);
        final to = nodes.indexOf(bodyEl);
        return [...nodes.sublist(0, from + 1), ...nodes.sublist(to)];
      }
      if (identical(el, bodyEl)) {
        final nodes = documentElement!.nodes;
        final between = nodes.sublist(nodes.indexOf(headEl!) + 1, nodes.indexOf(el));
        return _mergeText([...headSpill.spill, ...between, ...el.nodes]);
      }
    }
    if (tag == 'noscript') return _noscriptContent(el) ?? el.nodes;
    if ((tag == 'pre' || tag == 'listing') && el.nodes.isNotEmpty && _inTableCell(el)) {
      final first = el.nodes.first;
      if (first is dom.Text && first.data.startsWith('\n')) {
        return [if (first.data.length > 1) dom.Text(first.data.substring(1)), ...el.nodes.skip(1)];
      }
    }
    return el.nodes;
  }

  copy = (el, parent, inHead) {
    final tag = el.localName ?? '';
    if (tag == 'script') {
      final type = jsLower(_attr(el, 'type') ?? '');
      if (type == 'application/ld+json') {
        final text = _textContent(el);
        if (text.isNotEmpty) jsonLd.add(text);
      } else if (_attr(el, 'id') == '__NEXT_DATA__') {
        nextData = _textContent(el);
      } else if (type.startsWith('math/tex') && parent != null) {
        final math = VElement('math-tex', {'display': type.contains('mode=display') ? 'block' : 'inline'});
        math.append(VText(_textContent(el)));
        return math;
      }
      return null;
    }
    if (tag == 'base') {
      baseHref ??= _attr(el, 'href');
      return null;
    }
    // <object type="image/svg+xml" data="chart.svg"> is an image (LaTeXML figures, old sites).
    if (tag == 'object' && !inHead && _isImageObject(el)) {
      final img = VElement('img', {'src': _attr(el, 'data')!, 'alt': _attr(el, 'title') ?? ''});
      final width = _attr(el, 'width');
      final height = _attr(el, 'height');
      if (width != null) img.attrs['width'] = width;
      if (height != null) img.attrs['height'] = height;
      return img;
    }
    if (_drop.contains(tag)) return null;
    if (inHead && tag != 'title' && tag != 'meta' && tag != 'link' && tag != 'noscript') return null;
    // Streaming renderers (React 19, Next.js) emit <title>, <meta> and <link> inside <body>; keep them for metadata.
    if (tag == 'meta' || tag == 'link' || tag == 'title') {
      final a = el.attributes;
      if (!inHead &&
          tag == 'meta' &&
          !a.containsKey('itemprop') &&
          !a.containsKey('property') &&
          !a.containsKey('name')) {
        return null;
      }
    } else if (!inHead && _isHidden(el, tag)) {
      return null;
    }

    final attrs = <String, String>{};
    el.attributes.forEach((key, value) => attrs.putIfAbsent(_attrName(key), () => value));
    final v = VElement(tag, attrs);

    if (tag == 'math' || tag == 'svg') {
      // Kept as a leaf: math is serialized later; svg is dropped by the converter.
      v.append(VText(_textContent(el)));
      if (tag == 'math') {
        v.attrs['data-xml'] = _serializeXml(el);
        final annotation = _texAnnotation(el);
        if (annotation != null) {
          final tex = _textContent(annotation);
          if (tex.isNotEmpty) v.attrs['data-tex'] = jsTrim(tex);
        }
      }
      return v;
    }

    copyChildren(childNodes(el, tag), v, inHead || tag == 'head');
    if (tag == 'head') {
      head = v;
    } else if (tag == 'body') {
      body = v;
    }
    return v;
  };

  final root = (documentElement == null ? null : copy(documentElement, null, false)) ?? VElement('html', {});
  if (body == null) {
    body = VElement('body', {});
    root.append(body!);
  }
  return VDocument(root: root, head: head, body: body!, jsonLd: jsonLd, nextData: nextData, baseHref: baseHref);
}

final _imageFile = RegExp(r'\.(?:svg|png|jpe?g|gif|webp|avif)(?:$|[?#])', caseSensitive: false);

bool _isImageObject(dom.Element el) {
  final data = _attr(el, 'data');
  if (data == null || data.isEmpty) return false;
  final type = jsLower(_attr(el, 'type') ?? '');
  return type.startsWith('image/') || type.isEmpty && _imageFile.hasMatch(data);
}

/// `querySelector('annotation[encoding="application/x-tex"]')`.
dom.Element? _texAnnotation(dom.Element el) {
  for (final child in el.children) {
    if (child.localName == 'annotation' && child.attributes['encoding'] == 'application/x-tex') return child;
    final found = _texAnnotation(child);
    if (found != null) return found;
  }
  return null;
}

final _xmlAttr = RegExp(r'[&<>"]');
final _xmlText = RegExp(r'[&<>]');

String _xmlEscape(Match m) => switch (m[0]) {
  '&' => '&amp;',
  '<' => '&lt;',
  '>' => '&gt;',
  _ => '&quot;',
};

/// MathML presentation elements kept in `mathml`.
const _mathmlElements = {
  'math', 'semantics', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mrow', 'mfrac', 'msqrt', 'mroot', 'mstyle', //
  'merror', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
  'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maligngroup', 'malignmark', 'maction',
};

/// Dropped from `mathml` with their content: alternative encodings, and code.
const _mathmlDrop = {'annotation', 'annotation-xml', 'script', 'style', 'template'};

/// MathML presentation and global attributes kept in `mathml` (plus
/// `data-*`): no links, sources, handlers or styling.
const _mathmlAttributes = {
  'accent', 'accentunder', 'actiontype', 'align', 'alttext', 'arg', 'bevelled', 'close', 'columnalign', //
  'columnlines', 'columnspacing', 'columnspan', 'denomalign', 'depth', 'dir', 'display', 'displaystyle', 'encoding',
  'equalcolumns', 'equalrows', 'fence', 'form', 'frame', 'height', 'intent', 'largeop', 'linethickness', 'lspace',
  'mathbackground', 'mathcolor', 'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits', 'notation',
  'numalign', 'open', 'rowalign', 'rowlines', 'rowspacing', 'rowspan', 'rspace', 'scriptlevel', 'scriptminsize',
  'scriptsizemultiplier', 'selection', 'separator', 'separators', 'stretchy', 'subscriptshift', 'superscriptshift',
  'symmetric', 'voffset', 'width',
};

final _dataAttr = RegExp(r'^data-[a-z0-9-]+$');

/// Deterministic serialization of a MathML subtree (attributes in source
/// order, no namespaces). Only MathML elements and attributes are written;
/// anything else inside a formula (HTML in `<mtext>`, unknown tags) keeps
/// only its text, so the output is inert markup.
String _serializeXml(dom.Element el) {
  final out = StringBuffer();
  void visit(dom.Element el) {
    final tag = el.localName ?? '';
    if (_mathmlDrop.contains(tag)) return;
    final kept = _mathmlElements.contains(tag);
    if (kept) {
      out.write('<$tag');
      el.attributes.forEach((key, value) {
        final name = _attrName(key);
        if (!_mathmlAttributes.contains(name) && !_dataAttr.hasMatch(name)) return;
        out.write(' $name="${value.replaceAllMapped(_xmlAttr, _xmlEscape)}"');
      });
      out.write('>');
    }
    for (final child in el.nodes) {
      if (child is dom.Text) {
        out.write(child.data.replaceAllMapped(_xmlText, _xmlEscape));
      } else if (child is dom.Element) {
        visit(child);
      }
    }
    if (kept) out.write('</$tag>');
  }

  visit(el);
  return out.toString();
}
