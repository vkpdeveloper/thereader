/**
 * The JSON form of a `VDocument` the Dart port reads (`VDocument.fromJson` in
 * `packages/truffle_dart/lib/src/tree.dart`): a text node is a string, an
 * element `{ t, a?, c? }` with attributes in iteration order; `head` and `body`
 * are child-index paths from the root.
 */
import type { VDocument, VElement, VNode } from '../src/tree';

/** Compact JSON form of a node: text is a string, an element is `{ t, a?, c? }` (attributes in iteration order). */
function nodeJson(node: VNode): unknown {
  if (node.kind === 0) return node.text;
  const out: Record<string, unknown> = { t: node.tag };
  if (Object.keys(node.attrs).length > 0) out.a = node.attrs;
  if (node.children.length > 0) out.c = node.children.map(nodeJson);
  return out;
}

/** Child-index path from `root` to `target`, or null. */
function pathTo(root: VElement, target: VElement | null): number[] | null {
  if (target === null) return null;
  const path: number[] = [];
  for (let el: VElement = target; el !== root; el = el.parent!) {
    if (el.parent === null) return null;
    path.unshift(el.parent.children.indexOf(el));
  }
  return path;
}

export function vdocJson(doc: VDocument): unknown {
  return {
    root: nodeJson(doc.root),
    head: pathTo(doc.root, doc.head),
    body: pathTo(doc.root, doc.body),
    jsonLd: doc.jsonLd,
    nextData: doc.nextData,
    baseHref: doc.baseHref,
  };
}
