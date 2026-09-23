// THEREADER PATCH: theme enforcement, part 2 of 2 (part 1 is the tail of
// flutterReadiumTools.css). No stylesheet can beat an inline `!important`
// declaration, so this demotes inline `!important` colour declarations to
// normal priority exactly once per document. The declarations themselves are
// kept, so with the theme stylesheet disabled the publisher's colours return.
// Bounded: one pass over <html>, <body> and every element with a style
// attribute, after parsing. It never observes mutations and never runs per
// frame. Skipped, like the stylesheet: Readium's decoration layers (inline
// `!important` highlight tints), the TTS spotlight, and artwork (SVG, MathML,
// media and embeds, including their descendants), whose colours are pixels.
(function () {
  if (window.__thereaderThemeDemoted) return;
  window.__thereaderThemeDemoted = true;

  var PROPS = [
    'color',
    '-webkit-text-fill-color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'text-decoration-color',
    'text-shadow',
  ];
  var ARTWORK = 'svg, math, img, video, canvas, picture, object, embed, iframe';
  var SKIP =
    '[id^="r2-decoration-"], [id^="r2-decoration-"] *, .flutter-readium-spotlight, ' +
    ARTWORK + ', ' + ARTWORK.split(', ').map(function (s) { return s + ' *'; }).join(', ');

  function demoteElement(el) {
    var style = el.style;
    if (!style || el.matches(SKIP)) return 0;
    var changed = 0;
    for (var j = 0; j < PROPS.length; j++) {
      var prop = PROPS[j];
      if (style.getPropertyPriority(prop) === 'important') {
        style.setProperty(prop, style.getPropertyValue(prop), '');
        changed++;
      }
    }
    return changed;
  }

  // Demotes `root` itself and every styled descendant. Only the listed colour
  // properties are touched, so Readium's `--USER__` variables on <html> stay.
  function demote(root) {
    if (!root || !root.querySelectorAll) return 0;
    var changed = root.nodeType === 1 && root.hasAttribute('style') ? demoteElement(root) : 0;
    var nodes = root.querySelectorAll('[style]');
    for (var i = 0; i < nodes.length; i++) changed += demoteElement(nodes[i]);
    return changed;
  }

  window.thereaderDemoteInlineColors = demote;

  function run() {
    demote(document.documentElement);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
