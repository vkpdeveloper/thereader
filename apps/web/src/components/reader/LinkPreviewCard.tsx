import { useEffect, useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';

interface PreviewMetadata {
  url: string;
  title: string;
  description: string;
  faviconUrl: string;
}

const cache = new Map<string, PreviewMetadata>();

export function LinkPreviewCard({
  url,
  rect,
  onCancelClose,
  onScheduleClose,
}: {
  url: string;
  rect: DOMRect;
  onCancelClose: () => void;
  onScheduleClose: () => void;
}) {
  const [metadata, setMetadata] = useState<PreviewMetadata | null>(() => cache.get(url) ?? null);
  const host = new URL(url).hostname;

  useEffect(() => {
    setMetadata(cache.get(url) ?? null);
    if (cache.has(url)) return;
    const controller = new AbortController();
    fetch(`/v1/link-preview?url=${encodeURIComponent(url)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        return response.json() as Promise<PreviewMetadata>;
      })
      .then((result) => {
        cache.set(url, result);
        setMetadata(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMetadata({ url, title: host, description: '', faviconUrl: '' });
      });
    return () => controller.abort();
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
      <HoverCardContent side="bottom" align="start" sideOffset={8} collisionPadding={12}
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
