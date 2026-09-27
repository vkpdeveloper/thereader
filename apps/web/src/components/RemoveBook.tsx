import { useRef, useState, type ReactNode } from 'react';
import { isDownloadActive, isDownloadReady } from '../lib/format';
import type { AppServices } from '../lib/services/contract';
import { useServices, useStore } from '../lib/services/react';
import type { LibraryEntry } from '../lib/types';
import { ConfirmDialog } from './overlay';

type UploadPhase = 'none' | 'uploading' | 'pending' | 'failed';

/** Cloud state of one entry (mobile `uploadPhaseFor`). */
function uploadPhaseFor(services: AppServices, entry: LibraryEntry): UploadPhase {
  if (services.imports.isUploading(entry.id)) return 'uploading';
  if (services.imports.errorFor(entry.id) != null) return 'failed';
  if (services.imports.isPending(entry.id)) return 'pending';
  return 'none';
}

/**
 * Whether an entry has something local to remove. Removing a cloud download
 * keeps its synced metadata, so a cloud-only entry has nothing to remove;
 * an unpublished import can always be removed (its upload is cancelled).
 */
export function canRemove(services: AppServices, entry: LibraryEntry | undefined): entry is LibraryEntry {
  if (!entry) return false;
  const d = entry.download;
  return !isDownloadActive(d) && (d.status !== 'none' || services.imports.isPending(entry.id));
}

/** Web always syncs, so this is always "Remove download" (mobile: `d.isReady || sync != null`). */
export const removeLabel = 'Remove download';

/**
 * The confirmation before removing a book (mobile `_confirmRemove`). Cloud
 * books keep their position and library membership when local bytes go; an
 * unpublished import has its upload cancelled first. Always asks.
 */
export function useRemoveBook(): { ask: (entry: LibraryEntry) => void; dialog: ReactNode } {
  const services = useServices();
  // Observed so the dialog's wording follows the entry and upload state while open.
  useStore(services.imports);
  useStore(services.library);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Keeps the wording steady while the dialog fades out after a removal.
  const lastTarget = useRef<LibraryEntry | null>(null);
  const live = targetId ? services.library.entry(targetId) : undefined;
  if (live) lastTarget.current = live;
  const target = live ?? lastTarget.current;

  const phase = target ? uploadPhaseFor(services, target) : 'none';
  const keepMetadata = phase === 'none';
  const ready = target ? isDownloadReady(target.download) : false;
  const uploadNote =
    phase === 'none'
      ? ''
      : phase === 'uploading'
        ? ' The upload in progress will be cancelled.'
        : ' The waiting upload will be cancelled, so this book will not reach your other devices.';

  const remove = async () => {
    setOpen(false);
    if (!target) return;
    // Abort the upload before the bytes disappear; ids never queued are fine.
    await services.imports.cancelPending(target.id);
    await services.library.remove(target.id, { keepMetadata });
  };

  const dialog = (
    <ConfirmDialog
      open={open}
      title={ready || keepMetadata ? 'Remove download?' : 'Remove from library?'}
      body={
        (keepMetadata
          ? 'The file will be removed from this device. Your cloud book, reading position and reading time stay available.'
          : ready
            ? 'The file and your reading position for this book will be deleted from this device.'
            : 'This book and its reading position will be removed from your library. You can download it again from Browse.') +
        uploadNote
      }
      cancelLabel="Keep"
      confirmLabel="Remove"
      danger
      onCancel={() => setOpen(false)}
      onConfirm={() => void remove()}
    />
  );

  return {
    ask: (entry) => {
      setTargetId(entry.id);
      setOpen(true);
    },
    dialog,
  };
}
