import { inertProps } from '../../lib/hooks';
import type { ReadingLocator } from '../../lib/types';
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
  onMouseLeave,
}: {
  visible: boolean;
  title: string;
  panel: ReaderPanel | null;
  onClose: () => void;
  onPanel: (p: ReaderPanel) => void;
  fullscreen: boolean | null;
  onFullscreen: () => void;
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

/** Previous / chapter title + progress line + percent / next. */
export function BottomChrome({
  visible,
  locator,
  onPrevious,
  onNext,
}: {
  visible: boolean;
  locator: ReadingLocator | null;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const pct = percentOf(locator);
  return (
    <div className={visible ? 'reader-bottom is-visible' : 'reader-bottom'} {...inertProps(!visible)}>
      <IconButton icon={ChevronLeftIcon} label="Previous page" shortcut="←" tooltipSide="top" onClick={onPrevious} />
      <div className="reader-bottom-center">
        <div className="t-label-sm clamp-1 reader-chapter">{locator?.title ?? ''}</div>
        <ProgressLine value={(locator?.totalProgression ?? 0) || 0} label="Book progress" />
        <div className="t-label-sm tabular">{pct}%</div>
      </div>
      <IconButton icon={ChevronRightIcon} label="Next page" shortcut="→" tooltipSide="top" onClick={onNext} />
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
