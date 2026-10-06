import { memo, useEffect, useRef, useState } from 'react';
import type { Code } from '@thereader/extract';
import { languageLabel } from '../../lib/codeLanguages';
import { useInView } from '../../lib/hooks';
import type { Highlighted } from '../../lib/highlight';
import { IconButton } from '../buttons';
import { CheckIcon, CopyIcon } from '../icons';
import { useToast } from '../toast';

/** The highlighter chunk, fetched once and only for articles with code. */
let highlighter: Promise<typeof import('../../lib/highlight')> | null = null;
function loadHighlighter() {
  highlighter ??= import('../../lib/highlight').catch((e: unknown) => {
    highlighter = null;
    throw e;
  });
  return highlighter;
}

/**
 * A code block: language label and copy button above verbatim source that
 * scrolls sideways instead of wrapping. Highlighting runs when the block
 * nears the viewport; until then (or when no grammar fits) the code is plain.
 */
export const CodeBlock = memo(function CodeBlock({ block }: { block: Code }) {
  const ref = useRef<HTMLElement>(null);
  const near = useInView(ref, '600px');
  const toast = useToast();
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    loadHighlighter()
      .then((h) => h.highlightCode(block.code, block.language))
      .then(
        (result) => {
          if (!cancelled) setHighlighted(result);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [near, block]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
    } catch {
      toast.show("Couldn't copy the code.");
    }
  };

  const language = block.language ?? highlighted?.language ?? null;
  return (
    <figure ref={ref} className="article-code">
      <figcaption className="article-code-bar">
        {block.title && <span className="article-code-title clamp-1">{block.title}</span>}
        <span className="article-code-lang">{language ? languageLabel(language) : 'Code'}</span>
        <IconButton
          icon={copied ? CheckIcon : CopyIcon}
          label={copied ? 'Copied' : 'Copy code'}
          tone="muted"
          size={16}
          tooltipSide="left"
          className="article-code-copy"
          onClick={() => void copy()}
        />
      </figcaption>
      <pre tabIndex={0}>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        ) : (
          <code>{block.code}</code>
        )}
      </pre>
    </figure>
  );
});
