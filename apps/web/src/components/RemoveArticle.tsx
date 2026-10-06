import { useRef, useState, type ReactNode } from 'react';
import { useServices } from '../lib/services/react';
import type { ArticleSummary } from '../lib/types';
import { ConfirmDialog } from './overlay';

/** The confirmation before deleting a saved article and its reading position. */
export function useRemoveArticle(): { ask: (article: ArticleSummary) => void; dialog: ReactNode } {
  const services = useServices();
  const [open, setOpen] = useState(false);
  // Keeps the target while the dialog fades out.
  const target = useRef<ArticleSummary | null>(null);

  const dialog = (
    <ConfirmDialog
      open={open}
      title="Remove article?"
      body="The saved copy and your reading position will be deleted from this device. You can add it again from its link."
      cancelLabel="Keep"
      confirmLabel="Remove"
      danger
      onCancel={() => setOpen(false)}
      onConfirm={() => {
        setOpen(false);
        if (target.current) void services.articles.remove(target.current.id);
      }}
    />
  );

  return {
    ask: (article) => {
      target.current = article;
      setOpen(true);
    },
    dialog,
  };
}
