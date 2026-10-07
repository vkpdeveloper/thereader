import { closest, create, hasClass, nameOf } from './dom';

/**
 * Rule 6: tables scroll sideways inside the column instead of widening the
 * page. Each outermost table gets a scroll box (an element, no text).
 */
export function prepareTables(root: Element): number {
  let count = 0;
  for (const table of Array.from(root.getElementsByTagNameNS('*', 'table'))) {
    const parent = table.parentElement;
    if (!parent || hasClass(parent, 'tr-table-scroll')) continue;
    // Nested tables scroll with their outer table; layout tables inside code stay as they are.
    if (closest(parent, (e) => nameOf(e) === 'table' || nameOf(e) === 'pre')) continue;
    const box = create(root.ownerDocument, 'div', 'tr-table-scroll');
    parent.insertBefore(box, table);
    box.append(table);
    count++;
  }
  return count;
}
