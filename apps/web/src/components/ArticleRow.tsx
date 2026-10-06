import { memo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { articleLink } from '../lib/hooks';
import type { ArticleSummary } from '../lib/types';
import { IconButton } from './buttons';
import { MoreHorizIcon } from './icons';
import { menuPoint, type MenuPoint } from './overlay';
import { ProgressLine } from './states';

/** A publisher's favicon at text size; hidden when it fails to load. */
export function SiteIcon({ src, size = 14 }: { src: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      className="site-icon"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Lead image, or a quiet plate with the favicon (or the site's initial) when there is none. */
export function ArticleThumb({ article, shape = 'wide' }: { article: ArticleSummary; shape?: 'wide' | 'cover' }) {
  const [failed, setFailed] = useState(false);
  const cls = shape === 'cover' ? 'article-thumb is-cover' : 'article-thumb';
  if (article.image && !failed) {
    return (
      <div className={cls}>
        <img src={article.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={`${cls} is-plate`} aria-hidden="true">
      {article.favicon ? <SiteIcon src={article.favicon} size={22} /> : <span className="article-thumb-initial">{article.siteName.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

/** Progress for a saved article: nothing before the first read, a line while reading, then Finished. */
function articleStatus(article: ArticleSummary) {
  if (article.progress == null) return null;
  if (article.progress >= 0.995) return <span className="grid-status is-finished">Finished</span>;
  return (
    <span className="article-row-progress">
      <ProgressLine value={article.progress} label="Reading progress" />
      <span className="t-label-sm tabular">{Math.round(article.progress * 100)}%</span>
    </span>
  );
}

const longPressMs = 500;

/** One saved article in the Library: thumbnail, title, site and length, progress. */
export const ArticleRow = memo(function ArticleRow({
  article,
  onMenu,
}: {
  article: ArticleSummary;
  onMenu: (article: ArticleSummary, at: MenuPoint) => void;
}) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const lastPointer = useRef<string>('mouse');

  // Touch has no right click: a long press opens the same menu.
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType !== 'touch') return;
    cancelPress();
    const state = { x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    state.timer = window.setTimeout(() => {
      state.fired = true;
      onMenu(article, { x: state.x, y: state.y });
    }, longPressMs);
    press.current = state;
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (press.current?.fired) {
      e.preventDefault();
      e.stopPropagation();
    }
    press.current = null;
  };
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (lastPointer.current === 'touch') return;
    onMenu(article, menuPoint(e));
  };

  return (
    <li
      className="article-item"
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={onClickCapture}
    >
      <Link {...articleLink(article)} className="article-row" aria-label={`${article.title}, ${article.siteName}`}>
        <ArticleThumb article={article} />
        <div className="article-row-text">
          <div className="t-title-md clamp-2">{article.title}</div>
          <div className="article-row-meta t-body-sm">
            <SiteIcon src={article.favicon} />
            <span className="clamp-1">{article.siteName}</span>
            <span className="article-row-minutes tabular">· {article.readingMinutes} min</span>
          </div>
          <div className="article-row-status">{articleStatus(article)}</div>
        </div>
      </Link>
      <IconButton
        className="article-more"
        icon={MoreHorizIcon}
        label="Article actions"
        aria-haspopup="menu"
        size={18}
        tooltipSide="left"
        onClick={(e) => onMenu(article, menuPoint(e, 'below'))}
      />
    </li>
  );
});
