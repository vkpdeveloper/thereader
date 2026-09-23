// Runs the real vendor/flutter_readium/assets/helpers/thereaderTheme.js
// against a minimal DOM built from a JSON element tree, then prints each
// styled element's resulting inline style. Used by reader_typography_test.
//
// Usage: node theme_dom_harness.cjs <input.json>
//   input: { "script": "<path to thereaderTheme.js>", "tree": Node }
//   Node:  { "tag": "p", "attrs": { "id": "...", "style": "..." }, "children": [Node] }
// Output: { "<id or tag>": "<cssText>", ..., "__second": <demotions on rerun> }
//
// The shim implements only what the script uses. Unsupported selectors or
// APIs throw, so a script change cannot pass by silently matching nothing.
'use strict';
const fs = require('fs');
const vm = require('vm');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function parseStyle(text) {
  const map = new Map();
  for (const decl of (text || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    let prop = decl.slice(0, i).trim();
    if (!prop.startsWith('--')) prop = prop.toLowerCase();
    let value = decl.slice(i + 1).trim();
    let priority = '';
    const important = /\s*!\s*important\s*$/i.exec(value);
    if (important) {
      value = value.slice(0, important.index).trim();
      priority = 'important';
    }
    if (prop) map.set(prop, { value, priority });
  }
  return map;
}

class Style {
  constructor(text) { this.map = parseStyle(text); }
  getPropertyValue(p) { const d = this.map.get(p); return d ? d.value : ''; }
  getPropertyPriority(p) { const d = this.map.get(p); return d ? d.priority : ''; }
  setProperty(p, value, priority) {
    this.map.set(p, { value: String(value), priority: priority === 'important' ? 'important' : '' });
  }
  get cssText() {
    return [...this.map].map(([p, d]) => `${p}: ${d.value}${d.priority ? ' !important' : ''}`).join('; ');
  }
}

function matchesSimple(el, s) {
  let m;
  if ((m = /^\[id\^="([^"]*)"\]$/.exec(s))) return (el.attrs.id || '').startsWith(m[1]);
  if ((m = /^\.([\w-]+)$/.exec(s))) return (el.attrs.class || '').split(/\s+/).includes(m[1]);
  if (/^[a-z][a-z0-9]*$/.test(s)) return el.localName === s;
  throw new Error('harness: unsupported selector ' + s);
}

function matchesOne(el, s) {
  const descendant = /^(.+)\s+\*$/.exec(s);
  if (!descendant) return matchesSimple(el, s);
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (matchesSimple(a, descendant[1])) return true;
  }
  return false;
}

class Element {
  constructor(node, parent) {
    this.nodeType = 1;
    this.localName = node.tag;
    this.parentElement = parent;
    this.attrs = node.attrs;
    this.style = new Style(node.attrs.style);
    this.children = node.children.map((c) => new Element(c, this));
  }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  matches(list) { return list.split(',').some((s) => matchesOne(this, s.trim())); }
  querySelectorAll(selector) {
    if (selector !== '[style]') throw new Error('harness: unsupported query ' + selector);
    const out = [];
    const walk = (e) => e.children.forEach((c) => { if (c.hasAttribute('style')) out.push(c); walk(c); });
    walk(this);
    return out;
  }
}

const root = new Element(input.tree, null);
const window = {};
const document = {
  readyState: 'complete',
  documentElement: root,
  addEventListener() { throw new Error('harness: document is already parsed'); },
};
const context = vm.createContext({ window, document });
const source = fs.readFileSync(input.script, 'utf8');
vm.runInContext(source, context);
vm.runInContext(source, context); // A second injection must be a no-op.

const out = {};
const walk = (e) => {
  if (e.hasAttribute('style')) out[e.attrs.id || e.localName] = e.style.cssText;
  e.children.forEach(walk);
};
walk(root);
out.__second = window.thereaderDemoteInlineColors(root);
process.stdout.write(JSON.stringify(out));
