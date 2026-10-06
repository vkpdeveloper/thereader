import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface FootnotePeek {
  /** Footnote id (`data-fn`). */
  id: string;
  /** The note as already rendered at the end of the article, minus its back link. */
  html: string;
  /** The reference's box, in viewport coordinates. */
  anchor: DOMRect;
  dir: 'ltr' | 'rtl';
  lang?: string;
}

const gap = 8;
const margin = 12;

/** Copies a rendered footnote's body for the preview; null when the note is not in the document. */
export function footnotePeekHtml(id: string): string | null {
  const body = document.getElementById(`fn-${id}`)?.querySelector('.article-fn-body');
  if (!body) return null;
  const copy = body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.article-fn-back, [id]').forEach((el) => (el.classList.contains('article-fn-back') ? el.remove() : el.removeAttribute('id')));
  return copy.innerHTML;
}

/**
 * A footnote shown next to its reference while the pointer rests on it:
 * below the reference when there is room, else above, kept inside the
 * viewport. Hovering the preview keeps it open so its links can be used.
 */
export function FootnotePreview({ peek, onEnter, onLeave }: { peek: FootnotePeek; onEnter: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { anchor } = peek;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const below = anchor.bottom + gap + height <= window.innerHeight - margin || anchor.top - gap - height < margin;
    const top = below ? anchor.bottom + gap : anchor.top - gap - height;
    const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - margin - width);
    setStyle({ top: Math.max(margin, top), left });
  }, [peek]);

  return createPortal(
    <div
      ref={ref}
      className="article-fn-peek"
      style={style}
      dir={peek.dir}
      lang={peek.lang}
      role="tooltip"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      dangerouslySetInnerHTML={{ __html: peek.html }}
    />,
    // Inside the page so the reader's typography variables apply.
    document.querySelector('.article-page') ?? document.body,
  );
}
