import { useEffect, useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import './link-preview.css';

interface PreviewMetadata {
  url: string;
  title: string;
  description: string;
  faviconUrl: string;
}

const cache = new Map<string, PreviewMetadata>();
/** Requests still on their way; a card closed meanwhile lets them finish, so hovering the link again does not ask twice. */
const pending = new Map<string, Promise<PreviewMetadata>>();

function fetchPreview(url: string): Promise<PreviewMetadata> {
  let request = pending.get(url);
  if (!request) {
    request = fetch(`/v1/link-preview?url=${encodeURIComponent(url)}`)
      .then((response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        return response.json() as Promise<PreviewMetadata>;
      })
      .then((result) => {
        cache.set(url, result);
        return result;
      })
      .finally(() => pending.delete(url));
    pending.set(url, request);
  }
  return request;
}

export function LinkPreviewCard({
  url,
  rect,
  className,
  onCancelClose,
  onScheduleClose,
}: {
  url: string;
  rect: DOMRect;
  className?: string;
  onCancelClose: () => void;
  onScheduleClose: () => void;
}) {
  const [metadata, setMetadata] = useState<PreviewMetadata | null>(() => cache.get(url) ?? null);
  const host = new URL(url).hostname;

  useEffect(() => {
    setMetadata(cache.get(url) ?? null);
    if (cache.has(url)) return;
    // The API only reads https pages; a plain http link shows its domain without asking.
    if (!/^https:/i.test(url)) {
      const domainOnly = { url, title: host, description: '', faviconUrl: '' };
      cache.set(url, domainOnly);
      setMetadata(domainOnly);
      return;
    }
    let current = true;
    fetchPreview(url).then(
      (result) => {
        if (current) setMetadata(result);
      },
      () => {
        if (current) setMetadata({ url, title: host, description: '', faviconUrl: '' });
      },
    );
    return () => {
      current = false;
    };
  }, [url, host]);

  return (
    <HoverCard open openDelay={0} closeDelay={200}>
      <HoverCardTrigger asChild>
        <span
          aria-hidden="true"
          className="reader-link-hover-anchor"
          style={{ left: rect.left, top: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }}
        />
      </HoverCardTrigger>
      <HoverCardContent className={className} side="bottom" align="start" sideOffset={8} collisionPadding={12}
        onPointerEnter={onCancelClose} onPointerLeave={onScheduleClose}>
        <div className="reader-link-preview-source">
          {metadata?.faviconUrl && <img src={metadata.faviconUrl} width="16" height="16" alt="" />}
          <span>{host}</span>
        </div>
        <div className="reader-link-preview-title">{metadata?.title ?? 'Loading preview…'}</div>
        {metadata?.description && <p className="reader-link-preview-description">{metadata.description}</p>}
        <a className="reader-link-preview-open" href={url} target="_blank" rel="noopener noreferrer">Open link ↗</a>
      </HoverCardContent>
    </HoverCard>
  );
}
