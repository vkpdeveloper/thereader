import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { articleLink } from '../lib/hooks';
import type { ArticlePhase } from '../lib/services/contract';
import { useServices, useStore } from '../lib/services/react';
import { loadArticle } from '../routes/lazy';
import { LinkIcon } from './icons';
import { Dialog } from './overlay';
import { ProgressLine } from './states';
import { useToast } from './toast';

const phaseText: Record<ArticlePhase, string> = {
  fetching: 'Fetching the page…',
  extracting: 'Finding the article…',
  saving: 'Saving to this device…',
};

/**
 * Saves an article from a link. Enter submits; while it works the phase and a
 * progress line show under the field, errors stay inline, and success opens
 * the article. Closing cancels a save that has not finished.
 */
export function AddArticleDialog({ open, initialUrl, onClose }: { open: boolean; initialUrl: string; onClose: () => void }) {
  const services = useServices();
  const { adding } = useStore(services.articles);
  const navigate = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setError(null);
    // The reader screen loads while the page is fetched.
    void loadArticle().catch(() => undefined);
  }, [open, initialUrl]);

  const close = () => {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    onClose();
  };

  const submit = async () => {
    if (busy) return;
    if (!url.trim()) {
      setError('Paste a link to an article.');
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError(null);
    const started = Date.now();
    try {
      const summary = await services.articles.add(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      running.current = null;
      setBusy(false);
      onClose();
      if (Date.parse(summary.addedAt) < started) toast.show('Already in your library.');
      void navigate(articleLink(summary));
    } catch (e) {
      if (controller.signal.aborted) return;
      running.current = null;
      setBusy(false);
      setError(e instanceof Error && e.name !== 'AbortError' && e.message ? e.message : "Couldn't save that article.");
    }
  };

  const phase = busy ? adding : null;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add article"
      actions={
        <>
          <button type="button" className="text-button is-muted" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="add-article-form" className="text-button" disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <form
        id="add-article-form"
        className="add-article"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p>Paste a link to any article. It is saved on this device, ready to read offline.</p>
        <div className={error ? 'text-field has-prefix is-invalid' : 'text-field has-prefix'}>
          <LinkIcon size={18} className="text-field-prefix" />
          <input
            data-autofocus
            type="url"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="example.com/article"
            aria-label="Article link"
            aria-invalid={error != null}
            aria-describedby="add-article-status"
            readOnly={busy}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        <div id="add-article-status" className="add-article-status" aria-live="polite">
          {busy ? (
            <>
              <ProgressLine value={phase?.progress ?? null} working={phase?.phase === 'extracting'} label="Saving article" />
              <span className="t-body-sm">{phaseText[phase?.phase ?? 'fetching']}</span>
            </>
          ) : error ? (
            <span className="t-body-sm is-error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
