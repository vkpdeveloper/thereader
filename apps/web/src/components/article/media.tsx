import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Audio, Video } from 'truffle';
import { OpenInNewIcon, PlayArrowIcon } from '../icons';

const providerNames: Record<string, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  dailymotion: 'Dailymotion',
  twitch: 'Twitch',
  loom: 'Loom',
  wistia: 'Wistia',
  ted: 'TED',
  twitter: 'X',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  threads: 'Threads',
  reddit: 'Reddit',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  codepen: 'CodePen',
  gist: 'GitHub Gist',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  applepodcasts: 'Apple Podcasts',
  bandcamp: 'Bandcamp',
};

/** "YouTube", "X", or the host for providers without a name. */
export function providerName(provider: string, url: string): string {
  const known = providerNames[provider.toLowerCase()];
  if (known) return known;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return provider;
  }
}

/** Only absolute http(s) targets are ever linked or embedded. */
export function safeHref(url: string | undefined | null): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** Image sources: http(s), or inline raster/SVG data. */
export function safeSrc(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) || /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(url) ? url : undefined;
}

/** The API's media relay for an absolute http(s) file; `origin` is the API's. */
export function mediaRelayUrl(origin: string, url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? `${origin}/v1/media?url=${encodeURIComponent(url)}` : undefined;
}

/** The API origin article media falls back to; outside the article reader there is no fallback. */
export const MediaRelayOrigin = createContext<string | null>(null);

/**
 * How long an image may stay unloaded while on screen, directly and then
 * through the relay, before it counts as failed: a host that stalls or never
 * answers must not leave an empty reserved box.
 */
const STALL_MS = { direct: 10_000, relayed: 20_000 } as const;

const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

/**
 * A media source loaded directly first and, when that fails (hosts that
 * refuse to be embedded on other sites), once more through the API relay;
 * `failed` once neither loaded. The relay is never asked while the direct
 * load works, so most articles cost the API nothing. An image given `ref`
 * also fails over when it sits on screen without loading or erroring.
 */
export function useRelayedSrc(src: string | undefined): {
  src: string | undefined;
  relayed: boolean;
  failed: boolean;
  onError: () => void;
  ref: (img: HTMLImageElement | null) => void;
} {
  const origin = useContext(MediaRelayOrigin);
  const [stage, setStage] = useState<'direct' | 'relayed' | 'failed'>('direct');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const relay = origin && src ? mediaRelayUrl(origin, src) : undefined;
  const onError = () => setStage((current) => (current === 'direct' && relay ? 'relayed' : 'failed'));

  useEffect(() => {
    if (!img || stage === 'failed' || typeof IntersectionObserver === 'undefined') return;
    // Lazy images start loading near the viewport; the clock runs while one is on screen.
    let timer: number | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      window.clearTimeout(timer);
      if (!entry?.isIntersecting || loaded(img)) return;
      timer = window.setTimeout(() => {
        if (!loaded(img)) setStage((current) => (current === 'direct' && relay ? 'relayed' : 'failed'));
      }, STALL_MS[stage]);
    });
    observer.observe(img);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [img, stage, relay]);

  return {
    src: stage === 'direct' ? src : stage === 'relayed' ? relay : undefined,
    relayed: stage === 'relayed',
    failed: !src || stage === 'failed',
    onError,
    ref: setImg,
  };
}

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(?:www\.|m\.)/, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
      return m ? m[1] : null;
    }
  } catch {
    /* Not a URL. */
  }
  return null;
}

/** The player to load on click: YouTube through its no-cookie domain, autoplaying because the click asked for it. */
function playerUrl(video: Video): string | null {
  if (video.provider === 'youtube') {
    const id = youtubeId(video.embedUrl ?? video.url);
    if (!id) return null;
    const start = (() => {
      try {
        const t = new URL(video.embedUrl ?? video.url).searchParams.get('start') ?? new URL(video.url).searchParams.get('t');
        return t ? `&start=${parseInt(t, 10) || 0}` : '';
      } catch {
        return '';
      }
    })();
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0${start}`;
  }
  const embed = safeHref(video.embedUrl);
  if (!embed) return null;
  if (video.provider === 'vimeo') return `${embed}${embed.includes('?') ? '&' : '?'}autoplay=1`;
  return embed;
}

function posterFor(video: Video): string | undefined {
  const poster = safeSrc(video.poster);
  if (poster) return poster;
  if (video.provider === 'youtube') {
    const id = youtubeId(video.embedUrl ?? video.url);
    if (id) return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  }
  return undefined;
}

function MediaLink({ url, label }: { url: string; label: string }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a className="article-media-link" href={href} target="_blank" rel="noopener noreferrer">
      <span>{label}</span>
      <OpenInNewIcon size={14} />
    </a>
  );
}

/**
 * A video as a click-to-load facade: poster and play button, no player and
 * no video request until the reader asks. Video files then play in the
 * native player; their facade takes the poster's shape.
 */
export function VideoBlock({ video, caption }: { video: Video; caption: ReactNode }) {
  const [playing, setPlaying] = useState(false);
  const [ratio, setRatio] = useState<string>();
  const name = providerName(video.provider, video.url);
  const poster = useRelayedSrc(posterFor(video));
  const fileUrl = video.provider === 'file' ? safeHref(video.url) : undefined;
  // Mounted by the click, so it starts at once; a file that fails directly plays through the relay.
  const file = useRelayedSrc(fileUrl);
  const player = fileUrl ? null : playerUrl(video);
  const label = video.title ? `Play video: ${video.title}` : `Play ${name} video`;

  let body: ReactNode;
  if (file.failed && !player) {
    body = null;
  } else if (playing && !file.failed) {
    body = (
      <video
        className="article-video-frame"
        src={file.src}
        poster={poster.failed ? undefined : poster.src}
        controls
        autoPlay
        playsInline
        onError={file.onError}
      />
    );
  } else if (playing && player) {
    body = (
      <iframe
        className="article-video-frame"
        src={player}
        title={video.title ?? `${name} video`}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      />
    );
  } else {
    body = (
      <button type="button" className="article-video-facade" aria-label={label} onClick={() => setPlaying(true)}>
        {!poster.failed && (
          <img
            ref={poster.ref}
            src={poster.src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={poster.onError}
            onLoad={fileUrl ? (e) => setRatio(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`) : undefined}
          />
        )}
        <span className="article-play" aria-hidden="true">
          <PlayArrowIcon size={28} />
        </span>
        {/* A file's host name says nothing its caption does not. */}
        {(video.title || !fileUrl) && <span className="article-video-name">{video.title ?? name}</span>}
      </button>
    );
  }

  return (
    <figure className="article-media">
      {body && (
        <div className="article-video" style={ratio ? { aspectRatio: ratio } : undefined}>
          {body}
        </div>
      )}
      {!body && <MediaLink url={video.url} label={video.title ? `${video.title} · Watch on ${name}` : `Watch on ${name}`} />}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** An audio file's native player, loading nothing until played; falls back to the relay (playing on), then a link. */
function FileAudio({ url, label }: { url: string; label: string }) {
  const media = useRelayedSrc(url);
  if (media.failed) return <MediaLink url={url} label={label} />;
  return <audio className="article-audio" src={media.src} controls preload="none" autoPlay={media.relayed} onError={media.onError} />;
}

/** Audio files play natively; hosted players load on click. */
export function AudioBlock({ audio, caption }: { audio: Audio; caption: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const name = providerName(audio.provider, audio.url);
  const file = audio.provider === 'file' ? safeHref(audio.url) : undefined;
  const player = file ? undefined : safeHref(audio.embedUrl);

  let body: ReactNode;
  if (file) {
    body = <FileAudio url={file} label={audio.title ? `${audio.title} · Listen on ${name}` : `Listen on ${name}`} />;
  } else if (player && loaded) {
    body = (
      <iframe
        className="article-audio-frame"
        src={player}
        title={audio.title ?? `${name} player`}
        allow="autoplay; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    );
  } else if (player) {
    body = (
      <button type="button" className="article-audio-facade" onClick={() => setLoaded(true)}>
        <PlayArrowIcon size={20} />
        <span className="clamp-1">{audio.title ?? `Listen on ${name}`}</span>
        <span className="article-audio-provider">{name}</span>
      </button>
    );
  } else {
    body = <MediaLink url={audio.url} label={audio.title ? `${audio.title} · Listen on ${name}` : `Listen on ${name}`} />;
  }

  return (
    <figure className="article-media">
      {audio.title && file && <div className="article-audio-title t-title-sm">{audio.title}</div>}
      {body}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
