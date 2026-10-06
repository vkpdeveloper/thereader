import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LinkPreviewCard } from './LinkPreviewCard';

export interface HoveredLink {
  url: string;
  /** The link's box, in viewport coordinates. */
  rect: DOMRect;
}

/** Resting this long on a link opens its preview, so sweeping across text fetches nothing. */
const openDelayMs = 300;
/** Leaving a link or its card closes the card after this grace, enough to cross the gap between them. */
const closeGraceMs = 250;

/**
 * Hover intent for link previews, shared by the book and article readers:
 * `hover(link)` opens the card for a link after the reader rests on it,
 * `hover(null)` closes it after a grace period, and `dismiss` closes it at
 * once. The card only mounts (and fetches) once the delay has passed;
 * `busy()` is true from the hover until the card closes.
 */
export function useLinkPreview(options: { onShow?: () => void; className?: string } = {}): {
  link: HoveredLink | null;
  hover: (link: HoveredLink | null) => void;
  dismiss: () => void;
  busy: () => boolean;
  card: ReactNode;
} {
  const [link, setLink] = useState<HoveredLink | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const opening = useRef(false);
  const shown = useRef(false);
  shown.current = link != null;
  const onShow = useRef(options.onShow);
  onShow.current = options.onShow;

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const scheduleClose = useCallback(() => {
    opening.current = false;
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setLink(null), closeGraceMs);
  }, []);
  const hover = useCallback(
    (next: HoveredLink | null) => {
      if (!next) {
        scheduleClose();
        return;
      }
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(openTimer.current);
      setLink(null);
      opening.current = true;
      openTimer.current = window.setTimeout(() => {
        opening.current = false;
        setLink(next);
        onShow.current?.();
      }, openDelayMs);
    },
    [scheduleClose],
  );
  const dismiss = useCallback(() => {
    opening.current = false;
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setLink(null);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const card = link && (
    <LinkPreviewCard url={link.url} rect={link.rect} className={options.className} onCancelClose={cancelClose} onScheduleClose={scheduleClose} />
  );
  const busy = useCallback(() => opening.current || shown.current, []);
  return { link, hover, dismiss, busy, card };
}
