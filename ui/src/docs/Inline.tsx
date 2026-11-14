// The guide's three inline marks as React: **bold**, `code` and [label](href). Site links go through next/link;
// files (/docs.md, /llms.txt, the whitepaper) and other sites open as plain links, the latter in a new tab.
import Link from 'next/link'
import type { ReactNode } from 'react'

const MARK = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

export function Inline({ text }: { text: string }): ReactNode {
  return text.split(MARK).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}><Inline text={part.slice(2, -2)} /></b>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const [, label, href] = link
      if (href.startsWith('/') && !/\.(md|txt|pdf)$/.test(href)) return <Link key={i} href={href}>{label}</Link>
      if (href.startsWith('/')) return <a key={i} href={href}>{label}</a>
      return <a key={i} href={href} target="_blank" rel="noreferrer">{label} ↗</a>
    }
    return part
  })
}
