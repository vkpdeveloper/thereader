import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { readLink } from '../lib/hooks';
import { useServices } from '../lib/services/react';
import { useToast } from './toast';

interface LaunchParamsLike {
  files?: ReadonlyArray<{ kind: string; getFile(): Promise<File> }>;
}

interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

/**
 * Books opened from the operating system ("Open with The Reader" on an
 * installed app, via the manifest's `file_handlers`). Like mobile's
 * `_drainExternalBooks`: waits for the library, imports each file in turn
 * after any import already running, then opens the book in the reader.
 */
export function FileLaunchHandler() {
  const services = useServices();
  const navigate = useNavigate();
  const toast = useToast();
  const queue = useRef(Promise.resolve());
  const latest = useRef({ navigate, toast });
  latest.current = { navigate, toast };

  useEffect(() => {
    const launchQueue = (window as Window & { launchQueue?: LaunchQueueLike }).launchQueue;
    if (!launchQueue) return;
    launchQueue.setConsumer((params) => {
      const handles = (params.files ?? []).filter((h) => h.kind === 'file');
      if (handles.length === 0) return;
      queue.current = queue.current.then(async () => {
        await services.ready;
        for (const handle of handles) {
          try {
            await waitUntilIdle(services.imports);
            const entry = await services.imports.importFile(await handle.getFile());
            void latest.current.navigate(readLink(entry));
          } catch (e) {
            latest.current.toast.show(e instanceof Error && e.message ? `Could not open this book. ${e.message}` : 'Could not open this book.', {
              durationMs: 6000,
            });
          }
        }
      });
    });
  }, [services]);

  return null;
}

/** Resolves once no import is copying a file (uploads may continue). */
function waitUntilIdle(imports: { getSnapshot(): { busy: boolean }; subscribe(listener: () => void): () => void }): Promise<void> {
  if (!imports.getSnapshot().busy) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = imports.subscribe(() => {
      if (!imports.getSnapshot().busy) {
        unsubscribe();
        resolve();
      }
    });
  });
}
