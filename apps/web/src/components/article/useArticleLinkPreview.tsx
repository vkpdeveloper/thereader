import { useEffect, type ReactNode, type RefObject } from 'react';
import { hasOpenOverlay } from '../overlay';
import { useLinkPreview } from '../reader/useLinkPreview';
import { useCanHover, useIsDesktop } from '../../lib/hooks';

/** The URL without its fragment, so a section link compares equal to its page. */
function page(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

/**
 * The link a preview is for: one leading away from the article. Footnote
 * references and back links, section anchors and image zooms keep their own
 * behaviour, and links to the article's own page (its sections, or the
 * original) have nothing new to show.
 */
function previewLink(target: EventTarget | null, articlePage: string): HTMLAnchorElement | null {
  const node = target as Node | null;
  const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  const link = element?.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.closest('[data-fn], [data-fnback], [data-anchor], [data-zoom]')) return null;
  if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) return null;
  return page(link.href) === articlePage ? null : link;
}

/** The line of a wrapped link under the pointer, so the card opens next to it rather than below the whole paragraph. */
function lineRect(link: HTMLElement, x: number, y: number): DOMRect {
  for (const rect of link.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return rect;
  }
  return link.getBoundingClientRect();
}

/**
 * Link previews in a saved article, as in the book reader: a mouse resting on
 * a link opens a card with the linked page's title, description and icon.
 * Scrolling, a click, a key or an opening overlay closes it; resting on a
 * footnote reference closes it at once so the footnote's own preview takes
 * over, and `onShow` lets the article close that one when a card opens.
 */
export function useArticleLinkPreview(root: RefObject<HTMLElement | null>, articleUrl: string | null, onShow: () => void): ReactNode {
  const canHover = useCanHover();
  const desktop = useIsDesktop();
  const preview = useLinkPreview({ onShow, className: 'article-link-card' });
  const { hover, dismiss, busy } = preview;
  const active = canHover && desktop && articleUrl != null;

  useEffect(() => {
    const el = root.current;
    if (!active || !el || articleUrl == null) return;
    const articlePage = page(articleUrl);
    let hovered: HTMLAnchorElement | null = null;
    const close = () => {
      hovered = null;
      dismiss();
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if ((e.target as Element).closest?.('[data-fn]')) {
        if (busy()) close();
        return;
      }
      const link = previewLink(e.target, articlePage);
      if (link === hovered) return;
      hovered = link;
      if (link && hasOpenOverlay()) return;
      hover(link ? { url: link.href, rect: lineRect(link, e.clientX, e.clientY) } : null);
    };
    const onOut = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !hovered || hovered.contains(e.relatedTarget as Node | null)) return;
      hovered = null;
      hover(null);
    };
    // Keyboard focus shows the card too; a click's focus does not.
    const onFocusIn = (e: FocusEvent) => {
      const link = previewLink(e.target, articlePage);
      if (!link || !link.matches(':focus-visible') || hasOpenOverlay()) return;
      hover({ url: link.href, rect: link.getBoundingClientRect() });
    };
    const onFocusOut = () => {
      if (busy()) hover(null);
    };
    const onScroll = () => {
      if (busy()) close();
    };
    // Escape closes the card without also leaving the article.
    const onKey = (e: KeyboardEvent) => {
      if (!busy() || e.key === 'Tab' || e.key === 'Shift') return;
      if (e.key === 'Escape') e.stopPropagation();
      close();
    };

    el.addEventListener('pointerover', onOver);
    el.addEventListener('pointerout', onOut);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('click', close, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey, true);
    return () => {
      el.removeEventListener('pointerover', onOver);
      el.removeEventListener('pointerout', onOut);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      el.removeEventListener('click', close, true);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey, true);
      dismiss();
    };
  }, [active, articleUrl, root, hover, dismiss, busy]);

  return active ? preview.card : null;
}
