import type { TextIndex } from './text';

export const MARK_TAG = 'reader-hl';

export interface MarkSpan {
  id: string;
  color: string;
  start: number;
  end: number;
}

/** Removes every drawn highlight, merging the text nodes back together. */
export function clearMarks(root: Element): void {
  const marks = Array.from(root.getElementsByTagName(MARK_TAG));
  if (marks.length === 0) return;
  const parents = new Set<Node>();
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  }
  for (const p of parents) if (p.isConnected) p.normalize();
}

/**
 * Wraps each span's text in `<reader-hl data-hl-id>` elements, one per text
 * node piece, so highlights may cross element boundaries. Overlaps nest.
 * Invalidates `index` node references (offsets stay valid).
 */
export function drawMarks(index: TextIndex, spans: MarkSpan[]): void {
  const perNode = new Map<number, { a: number; b: number; span: MarkSpan }[]>();
  for (const span of spans) {
    if (span.end <= span.start) continue;
    for (let i = index.nodeAt(span.start); i < index.nodes.length && index.starts[i] < span.end; i++) {
      const len = index.nodes[i].data.length;
      const a = Math.max(span.start, index.starts[i]) - index.starts[i];
      const b = Math.min(span.end, index.starts[i] + len) - index.starts[i];
      if (a >= b) continue;
      let list = perNode.get(i);
      if (!list) perNode.set(i, (list = []));
      list.push({ a, b, span });
    }
  }
  const doc = index.root.ownerDocument;
  for (const [i, pieces] of perNode) {
    const node = index.nodes[i];
    const cuts = new Set<number>([0, node.data.length]);
    for (const p of pieces) {
      cuts.add(p.a);
      cuts.add(p.b);
    }
    const sorted = [...cuts].sort((x, y) => x - y);
    // Split from the end so earlier offsets stay valid.
    const segments: { text: Text; from: number; to: number }[] = [];
    let current = node;
    for (let k = sorted.length - 2; k >= 0; k--) {
      const from = sorted[k];
      const to = sorted[k + 1];
      const seg = from > 0 ? current.splitText(from) : current;
      segments.push({ text: seg, from, to });
    }
    for (const seg of segments) {
      const covering = pieces.filter((p) => p.a <= seg.from && seg.to <= p.b).map((p) => p.span);
      if (covering.length === 0 || !/\S/.test(seg.text.data)) continue;
      let inner: Node = seg.text;
      const parent = seg.text.parentNode;
      if (!parent) continue;
      const placeholder = doc.createTextNode('');
      parent.replaceChild(placeholder, seg.text);
      for (let c = covering.length - 1; c >= 0; c--) {
        const mark = doc.createElement(MARK_TAG);
        mark.setAttribute('data-hl-id', covering[c].id);
        mark.setAttribute('data-hl-color', covering[c].color);
        mark.append(inner);
        inner = mark;
      }
      parent.replaceChild(inner, placeholder);
    }
  }
}
