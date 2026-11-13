import type { ReactNode } from 'react'
import { type Block, type Inline, parseMarkdown } from './markdown-model'

const HEADING = {
  1: 'text-2xl font-semibold',
  2: 'text-xl font-semibold',
  3: 'text-lg font-semibold',
  4: 'text-base font-semibold',
  5: 'text-sm font-semibold',
  6: 'text-sm font-semibold text-muted-foreground',
} as const

/** Markdown as React elements (never HTML): see `markdown-model.ts`. */
export function Markdown({ source }: { source: string }) {
  return <div className="space-y-2">{parseMarkdown(source).map((block, i) => renderBlock(block, i))}</div>
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as const
      return (
        <Tag key={key} className={HEADING[block.level]}>
          {inline(block.children)}
        </Tag>
      )
    }
    case 'paragraph':
      return <p key={key}>{inline(block.children)}</p>
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List key={key} className={block.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity but their place.
            <li key={i}>{inline(item)}</li>
          ))}
        </List>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">
          {inline(block.children)}
        </blockquote>
      )
    case 'code':
      return (
        <pre
          key={key}
          className="overflow-auto rounded bg-foreground/5 p-2 font-mono text-xs text-foreground"
        >
          {block.text}
        </pre>
      )
    case 'rule':
      return <hr key={key} className="border-border" />
  }
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'br':
        // biome-ignore lint/suspicious/noArrayIndexKey: inline pieces have no identity but their place.
        return <br key={key} />
      case 'strong':
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        return <strong key={key}>{inline(node.children)}</strong>
      case 'em':
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        return <em key={key}>{inline(node.children)}</em>
      case 'del':
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        return <del key={key}>{inline(node.children)}</del>
      case 'code':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
          <code key={key} className="rounded bg-foreground/10 px-1 font-mono text-[0.9em] text-foreground">
            {node.text}
          </code>
        )
      case 'link':
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: as above.
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {inline(node.children)}
          </a>
        )
      default:
        return null
    }
  })
}
