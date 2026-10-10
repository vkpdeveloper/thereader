/** What a key does in the comic reader. Comics have no text tools, so the map is short. */
export type ComicKeyAction = 'next' | 'previous' | 'first' | 'last' | 'close' | 'chrome' | 'fullscreen' | 'zoomIn' | 'zoomOut' | 'zoomReset';

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function comicKeyAction(e: KeyLike): ComicKeyAction | null {
  if (e.key === 'Escape') return 'close';
  // Modified keys stay the browser's: ⌘/Ctrl + and − still zoom the whole page.
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return 'previous';
    case ' ':
    case 'Spacebar':
      return e.shiftKey ? 'previous' : 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'm':
      return 'chrome';
    case 'f':
      return 'fullscreen';
    case '+':
    case '=':
      return 'zoomIn';
    case '-':
    case '_':
      return 'zoomOut';
    case '0':
      return 'zoomReset';
    default:
      return null;
  }
}
