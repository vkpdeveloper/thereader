import { inertProps } from '../../lib/hooks';
import type { ReadingLocator } from '../../lib/types';
import type { PageInfo } from '../../reader/engine';
import { IconButton } from '../buttons';
import {
  ArrowUpwardIcon,
  BorderColorIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FormatListIcon,
  FullscreenExitIcon,
  FullscreenIcon,
  SearchIcon,
  TextFieldsIcon,
} from '../icons';
import { ProgressLine } from '../states';
import { KeyboardIcon } from './ShortcutsDialog';

export type ReaderPanel = 'contents' | 'highlights' | 'search' | 'typography';

const percentOf = (loc: ReadingLocator | null) => Math.round(Math.min(1, Math.max(0, loc?.totalProgression ?? 0)) * 100);

/** Opaque top bar: close, title, then the four reading tools. */
export function TopChrome({
  visible,
  title,
  panel,
  onClose,
  onPanel,
  fullscreen,
  onFullscreen,
  onShortcuts,
  onMouseLeave,
}: {
  visible: boolean;
  title: string;
  panel: ReaderPanel | null;
  onClose: () => void;
  onPanel: (p: ReaderPanel) => void;
  fullscreen: boolean | null;
  onFullscreen: () => void;
  onShortcuts: () => void;
  onMouseLeave?: () => void;
}) {
  const tool = (p: ReaderPanel) => ({ 'aria-pressed': panel === p, className: panel === p ? 'is-active' : undefined });
  return (
    <div className={visible ? 'reader-top is-visible' : 'reader-top'} {...inertProps(!visible)} onMouseLeave={onMouseLeave}>
      <IconButton icon={CloseIcon} label="Close book" shortcut="Esc" onClick={onClose} />
      <div className="reader-top-title t-title-sm clamp-1">{title}</div>
      <IconButton icon={FormatListIcon} label="Contents" shortcut="T" onClick={() => onPanel('contents')} {...tool('contents')} />
      <IconButton icon={BorderColorIcon} label="Highlights" shortcut="H" onClick={() => onPanel('highlights')} {...tool('highlights')} />
      <IconButton icon={SearchIcon} label="Search book" shortcut="/" onClick={() => onPanel('search')} {...tool('search')} />
      <IconButton icon={TextFieldsIcon} label="Typography" shortcut="A" onClick={() => onPanel('typography')} {...tool('typography')} />
      <IconButton className="desktop-only-flex" icon={KeyboardIcon} label="Keyboard shortcuts" shortcut="?" onClick={onShortcuts} />
      {fullscreen !== null && (
        <IconButton
          className="desktop-only-flex"
          icon={fullscreen ? FullscreenExitIcon : FullscreenIcon}
          label={fullscreen ? 'Exit full screen' : 'Full screen'}
          shortcut="F"
          tooltipSide="left"
          onClick={onFullscreen}
        />
      )}
    </div>
  );
}

/** "3 pages left in chapter" while paginated; the last page says so. */
function pagesLeft(page: PageInfo | null): string | null {
  if (!page || page.count < 2) return null;
  const left = page.count - 1 - page.index;
  return left === 0 ? 'Last page in chapter' : left === 1 ? '1 page left in chapter' : `${left} pages left in chapter`;
}

/**
 * Previous / chapter title + progress line + percent / next. Right-to-left
 * books turn forwards to the left, so the arrows swap roles.
 */
export function BottomChrome({
  visible,
  locator,
  page,
  rtl,
  onPrevious,
  onNext,
}: {
  visible: boolean;
  locator: ReadingLocator | null;
  page: PageInfo | null;
  rtl: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const pct = percentOf(locator);
  const left = pagesLeft(page);
  const back = <IconButton icon={ChevronLeftIcon} label={rtl ? 'Next page' : 'Previous page'} shortcut="←" tooltipSide="top" onClick={rtl ? onNext : onPrevious} />;
  const forward = <IconButton icon={ChevronRightIcon} label={rtl ? 'Previous page' : 'Next page'} shortcut="→" tooltipSide="top" onClick={rtl ? onPrevious : onNext} />;
  return (
    <div className={visible ? 'reader-bottom is-visible' : 'reader-bottom'} {...inertProps(!visible)}>
      {back}
      <div className="reader-bottom-center">
        <div className="t-label-sm clamp-1 reader-chapter">{locator?.title ?? ''}</div>
        <ProgressLine value={(locator?.totalProgression ?? 0) || 0} label="Book progress" />
        <div className="t-label-sm tabular">
          {pct}%{left && <span className="reader-pages-left"> · {left}</span>}
        </div>
      </div>
      {forward}
    </div>
  );
}

/** Quiet corner readout while the chrome is hidden. */
export function EdgeProgress({ visible, locator }: { visible: boolean; locator: ReadingLocator | null }) {
  return (
    <div className={visible ? 'reader-edge-progress is-visible' : 'reader-edge-progress'} aria-hidden="true">
      {percentOf(locator)}%
    </div>
  );
}

/** Floats over the lower right once the reader is past the chapter's start. */
export function ToChapterStart({
  chromeVisible,
  locator,
  onPress,
}: {
  chromeVisible: boolean;
  locator: ReadingLocator | null;
  onPress: () => void;
}) {
  const shown = (locator?.progression ?? 0) > 0.02;
  return (
    <div
      className={['reader-chapter-start', shown && 'is-shown', chromeVisible && 'is-raised'].filter(Boolean).join(' ')}
      {...inertProps(!shown)}
    >
      <IconButton icon={ArrowUpwardIcon} label="Back to top" shortcut="Home" tooltipSide="left" onClick={onPress} />
    </div>
  );
}
