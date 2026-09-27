import { useMemo, type ReactNode } from 'react';
import { parseDescription, type Block, type Inline } from '../lib/richText';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'br':
        return <br key={i} />;
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(node.children)}
          </a>
        );
      case 'mark': {
        const Tag = node.tag;
        return <Tag key={i}>{renderInline(node.children)}</Tag>;
      }
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.kind) {
      case 'p':
        return block.heading ? (
          <p key={i} className="rich-heading">
            <strong>{renderInline(block.children)}</strong>
          </p>
        ) : (
          <p key={i}>{renderInline(block.children)}</p>
        );
      case 'quote':
        return <blockquote key={i}>{renderBlocks(block.children)}</blockquote>;
      case 'list': {
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{renderBlocks(item)}</li>
            ))}
          </List>
        );
      }
    }
  });
}

/** Renders a plain-text or HTML description through the richText allowlist. */
export function RichText({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseDescription(source), [source]);
  if (!blocks.length) return null;
  return <div className={className}>{renderBlocks(blocks)}</div>;
}
