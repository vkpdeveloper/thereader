import { Fragment, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { inlineText, type Block, type Figure, type Image, type Inline, type InlineImage, type Mark, type Table, type TextRun } from '@thereader/extract';
import { CodeBlock } from './CodeBlock';
import { MathView } from './math';
import { AudioBlock, VideoBlock, providerName, safeHref, safeSrc } from './media';

/**
 * Renders the article document model to semantic HTML. Plain functions build
 * the static tree once per article; only interactive pieces (code, media,
 * math, images) are components. Footnote jumps, heading links and image
 * zoom are handled by one delegated click listener on the article root,
 * keyed by `data-fn`, `data-fnback`, `data-anchor` and `data-zoom`.
 */

export interface RenderContext {
  /** `sizes` for article images: the text column on wide screens, the viewport on narrow ones. */
  sizes: string;
  /** Footnotes whose first reference already carries the return anchor. */
  seenRefs: Set<string>;
}

const calloutTitles = { note: 'Note', tip: 'Tip', info: 'Info', warning: 'Warning', danger: 'Danger' } as const;

function wrap(mark: Mark, child: ReactNode): ReactNode {
  switch (mark) {
    case 'bold':
      return <strong>{child}</strong>;
    case 'italic':
      return <em>{child}</em>;
    case 'underline':
      return <u>{child}</u>;
    case 'strike':
      return <s>{child}</s>;
    case 'code':
      return <code>{child}</code>;
    case 'sub':
      return <sub>{child}</sub>;
    case 'sup':
      return <sup>{child}</sup>;
    case 'highlight':
      return <mark>{child}</mark>;
    case 'small':
      return <small>{child}</small>;
    case 'kbd':
      return <kbd>{child}</kbd>;
  }
}

/** Marks are sorted in `Mark` order; the first is outermost. */
function marked(run: TextRun): ReactNode {
  let node: ReactNode = run.text;
  const marks = run.marks;
  if (marks) for (let m = marks.length - 1; m >= 0; m--) node = wrap(marks[m], node);
  return node;
}

/** A small image inside a line; when it cannot load, its alt text stands in. */
function InlineImageView({ image }: { image: InlineImage }) {
  const [failed, setFailed] = useState(false);
  const src = safeSrc(image.src);
  if (!src || failed) return <>{image.alt}</>;
  return (
    <img
      className="article-inline-image"
      src={src}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function renderInline(node: Inline, ctx: RenderContext): ReactNode {
  switch (node.type) {
    case 'text':
      return marked(node);
    case 'break':
      return <br />;
    case 'image':
      return <InlineImageView image={node} />;
    case 'math':
      return <MathView math={node} display="inline" />;
    case 'ref': {
      const first = !ctx.seenRefs.has(node.id);
      ctx.seenRefs.add(node.id);
      return (
        <sup className="article-fnref">
          <a href={`#fn-${node.id}`} id={first ? `fnref-${node.id}` : undefined} data-fn={node.id} aria-label={`Footnote ${node.label}`}>
            {node.label}
          </a>
        </sup>
      );
    }
  }
}

/** Inline content; consecutive runs sharing a link become one anchor that opens in a new tab. */
export function renderInlines(content: readonly Inline[], ctx: RenderContext): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    if (node.type === 'text' && node.href) {
      const start = i;
      const runs: TextRun[] = [node];
      while (i + 1 < content.length) {
        const next = content[i + 1];
        if (next.type !== 'text' || next.href !== node.href) break;
        runs.push(next);
        i++;
      }
      const inner = runs.map((run, j) => <Fragment key={j}>{marked(run)}</Fragment>);
      const href = safeHref(node.href);
      out.push(
        href ? (
          <a key={start} href={href} target="_blank" rel="noopener noreferrer">
            {inner}
          </a>
        ) : (
          <Fragment key={start}>{inner}</Fragment>
        ),
      );
      continue;
    }
    out.push(<Fragment key={i}>{renderInline(node, ctx)}</Fragment>);
  }
  return out;
}

const imageFile = /\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#]|$)/i;

/** The largest version for the zoomed view: a linked image file, the widest srcset candidate, or the source. */
function fullSize(image: Image): string {
  const linked = safeHref(image.href);
  if (linked && imageFile.test(linked)) return linked;
  let best = image.src;
  let bestWidth = image.width ?? 0;
  for (const candidate of image.srcset?.split(/,\s+/) ?? []) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    const width = descriptor?.endsWith('w') ? parseInt(descriptor, 10) : 0;
    if (url && safeHref(url) && width > bestWidth) {
      best = url;
      bestWidth = width;
    }
  }
  return best;
}

function cleanSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  const parts = srcset.split(/,\s+/).filter((candidate) => safeHref(candidate.trim().split(/\s+/)[0]));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** An article image with reserved space (width/height), lazy decoding and no referrer; failures show the alt text. */
export function ArticleImage({ image, sizes }: { image: Image; sizes: string }) {
  const [failed, setFailed] = useState(false);
  const src = safeSrc(image.src);
  if (!src || failed) return <span className="article-image-missing">{image.alt || 'Image unavailable'}</span>;
  return (
    <img
      src={src}
      srcSet={cleanSrcset(image.srcset)}
      sizes={image.srcset ? sizes : undefined}
      width={image.width}
      height={image.height}
      alt={image.alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function renderFigure(block: Figure, ctx: RenderContext): ReactNode {
  const gallery = block.images.length > 1;
  return (
    <figure className={gallery ? 'article-figure is-gallery' : 'article-figure'}>
      <div className="article-figure-images" data-count={gallery ? Math.min(block.images.length, 3) : undefined}>
        {block.images.map((image, i) => (
          <button
            key={i}
            type="button"
            className="article-zoom"
            data-zoom={fullSize(image)}
            data-alt={image.alt}
            aria-label={image.alt ? `Open image: ${image.alt}` : 'Open image'}
          >
            <ArticleImage image={image} sizes={gallery ? '(min-width: 760px) 360px, 50vw' : ctx.sizes} />
          </button>
        ))}
      </div>
      {(block.caption || block.credit) && (
        <figcaption>
          {block.caption && renderInlines(block.caption, ctx)}
          {block.credit && <span className="article-credit">{renderInlines(block.credit, ctx)}</span>}
        </figcaption>
      )}
    </figure>
  );
}

function renderTable(block: Table, ctx: RenderContext): ReactNode {
  const headerRows = Math.min(block.headerRows ?? 0, block.rows.length);
  const row = (cells: Table['rows'][number]['cells'], head: boolean, key: number) => (
    <tr key={key}>
      {cells.map((cell, i) => {
        const Cell = head || cell.header ? 'th' : 'td';
        return (
          <Cell
            key={i}
            className={inlineText(cell.content).length <= 16 ? 'is-short' : undefined}
            scope={head ? 'col' : cell.header ? 'row' : undefined}
            colSpan={cell.colspan}
            rowSpan={cell.rowspan}
            style={cell.align ? { textAlign: cell.align } : undefined}
          >
            {renderInlines(cell.content, ctx)}
          </Cell>
        );
      })}
    </tr>
  );
  return (
    <div className="article-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        {block.caption && <caption>{renderInlines(block.caption, ctx)}</caption>}
        {headerRows > 0 && <thead>{block.rows.slice(0, headerRows).map((r, i) => row(r.cells, true, i))}</thead>}
        <tbody>{block.rows.slice(headerRows).map((r, i) => row(r.cells, false, i))}</tbody>
      </table>
    </div>
  );
}

function renderBlock(block: Block, ctx: RenderContext): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Heading = `h${block.level}` as const;
      const id = block.anchor ? `section-${block.anchor}` : undefined;
      return (
        <Heading id={id} className="article-heading">
          {renderInlines(block.content, ctx)}
          {block.anchor && (
            <a className="article-anchor" href={`#${id}`} data-anchor={block.anchor} aria-label="Copy link to this section">
              #
            </a>
          )}
        </Heading>
      );
    }
    case 'paragraph':
      return block.content.length > 0 ? <p>{renderInlines(block.content, ctx)}</p> : null;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === undefined ? undefined : 'is-task'}>
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly disabled aria-label={item.checked ? 'Done' : 'To do'} />}
          {renderBlocks(item.blocks, ctx)}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'quote':
      return (
        <blockquote className={block.pull ? 'article-pullquote' : 'article-quote'} aria-hidden={block.pull || undefined}>
          {renderBlocks(block.blocks, ctx)}
          {block.cite && (
            <footer>
              <cite>{renderInlines(block.cite, ctx)}</cite>
            </footer>
          )}
        </blockquote>
      );
    case 'code':
      return <CodeBlock block={block} />;
    case 'figure':
      return renderFigure(block, ctx);
    case 'video':
      return <VideoBlock video={block} caption={block.caption && renderInlines(block.caption, ctx)} />;
    case 'audio':
      return <AudioBlock audio={block} caption={block.caption && renderInlines(block.caption, ctx)} />;
    case 'embed': {
      const name = providerName(block.provider, block.url);
      const href = safeHref(block.url);
      return (
        <figure className="article-embed">
          <figcaption className="article-embed-head">
            <span className="eyebrow">{name}</span>
            {block.author && <span className="article-embed-author clamp-1">{block.author}</span>}
          </figcaption>
          {block.blocks && block.blocks.length > 0 && <div className="article-embed-body">{renderBlocks(block.blocks, ctx)}</div>}
          {href && (
            <a className="article-embed-link" href={href} target="_blank" rel="noopener noreferrer">
              View on {name}
            </a>
          )}
        </figure>
      );
    }
    case 'table':
      return renderTable(block, ctx);
    case 'rule':
      return <hr className="article-rule" />;
    case 'math':
      return <MathView math={block} display="block" />;
    case 'definitions':
      return (
        <dl className="article-definitions">
          {block.items.map((item, i) => (
            <Fragment key={i}>
              <dt>{renderInlines(item.term, ctx)}</dt>
              <dd>{renderBlocks(item.details, ctx)}</dd>
            </Fragment>
          ))}
        </dl>
      );
    case 'details':
      return (
        <details className="article-details">
          <summary>{renderInlines(block.summary, ctx)}</summary>
          <div className="article-details-body">{renderBlocks(block.blocks, ctx)}</div>
        </details>
      );
    case 'callout': {
      const title = block.title ? renderInlines(block.title, ctx) : block.variant ? calloutTitles[block.variant] : null;
      return (
        <aside className={`article-callout is-${block.variant ?? 'plain'}`} role="note">
          {title && <div className="article-callout-title">{title}</div>}
          {renderBlocks(block.blocks, ctx)}
        </aside>
      );
    }
    case 'footnotes':
      return (
        <section className="article-footnotes" aria-label="Footnotes">
          <ol>
            {block.items.map((item) => (
              <li key={item.id} id={`fn-${item.id}`}>
                <span className="article-fn-label">{item.label}</span>
                <div className="article-fn-body">
                  {renderBlocks(item.blocks, ctx)}
                  <a className="article-fn-back" href={`#fnref-${item.id}`} data-fnback={item.id} aria-label={`Back to reference ${item.label}`}>
                    ↩
                  </a>
                </div>
              </li>
            ))}
          </ol>
        </section>
      );
  }
}

export function renderBlocks(blocks: readonly Block[], ctx: RenderContext): ReactNode[] {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, ctx)}</Fragment>);
}

/**
 * The article's top-level blocks, each marked with its index in `blocks`
 * (`data-block-index`): reading positions sync between devices as block
 * indexes, so they must not depend on how many elements a block renders. An
 * element carries the marker itself; a component gets a box-less wrapper.
 */
export function renderArticleBlocks(blocks: readonly Block[], ctx: RenderContext): ReactNode[] {
  return blocks.map((block, i) => {
    const node = renderBlock(block, ctx);
    if (node == null) return null;
    if (isValidElement(node) && typeof node.type === 'string') {
      return cloneElement(node as ReactElement<{ 'data-block-index'?: number }>, { key: i, 'data-block-index': i });
    }
    return (
      <div key={i} className="article-block-contents" data-block-index={i}>
        {node}
      </div>
    );
  });
}
