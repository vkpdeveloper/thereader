import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, usePresence } from '../../lib/hooks';
import { IconButton } from '../buttons';
import { CloseIcon } from '../icons';
import { useOverlayLayer } from '../overlay';
import { useRelayedSrc } from './media';

export interface ZoomedImage {
  src: string;
  alt: string;
}

/** The full-size file; one its host refuses to show here is retried through the relay. */
function ZoomedImg({ image }: { image: ZoomedImage }) {
  const media = useRelayedSrc(image.src);
  if (media.failed) return null;
  return <img className="lightbox-image" src={media.src} alt={image.alt} referrerPolicy="no-referrer" decoding="async" onError={media.onError} />;
}

/** A tapped article image at full size over a dark scrim; a click anywhere or Escape closes it. */
export function Lightbox({ image, onClose }: { image: ZoomedImage | null; onClose: () => void }) {
  const open = image != null;
  const { mounted, shown } = usePresence(open, 220);
  const panel = useRef<HTMLDivElement>(null);
  const last = useRef<ZoomedImage | null>(null);
  if (image) last.current = image;
  useOverlayLayer(open, onClose);
  useFocusTrap(panel, open && mounted);
  const current = image ?? last.current;
  if (!mounted || !current) return null;
  return createPortal(
    <div
      ref={panel}
      className={shown ? 'overlay lightbox is-shown' : 'overlay lightbox'}
      role="dialog"
      aria-modal="true"
      aria-label={current.alt || 'Image'}
      onClick={onClose}
    >
      <div className="overlay-scrim" />
      <ZoomedImg key={current.src} image={current} />
      {current.alt && <p className="lightbox-caption">{current.alt}</p>}
      <IconButton className="lightbox-close" icon={CloseIcon} label="Close image" tooltipSide="left" data-autofocus onClick={onClose} />
    </div>,
    document.body,
  );
}
