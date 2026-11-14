// The guide as plain Markdown (served at /docs.md) and the short /llms.txt that points to it. Both are written from
// docsSections() by docs-md.test.ts, which also fails when the committed files in public/ fall behind the page.
import { BRAND } from '../chain/brand'
import { DOCS_LEDE, DOCS_TITLE, README_URL, SITE_URL, WHITEPAPER_URL, docsSections, type Block, type DocIds } from './content'

/** Site-relative links become absolute, so the file reads the same wherever it is copied. */
const absolute = (text: string): string => text.replace(/\]\((\/[^)]*)\)/g, (_, href: string) => `](${SITE_URL}${href})`)
const cell = (s: string) => absolute(s).replace(/\|/g, '\\|')

function block(b: Block): string {
  switch (b.type) {
    case 'p': return absolute(b.text)
    case 'note': return `> ${absolute(b.text)}`
    case 'h3': return `### ${b.text}`
    case 'list': return b.items.map((x, i) => `${b.ordered ? `${i + 1}.` : '-'} ${absolute(x)}`).join('\n')
    case 'table': return [`| ${b.head.map(cell).join(' | ')} |`, `|${b.head.map(() => '---').join('|')}|`, ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
    case 'code': return ['```', b.text, '```'].join('\n')
    case 'terms': return b.items.map(([t, d]) => `- **${t}**: ${absolute(d)}`).join('\n')
    case 'live': return absolute(b.md)
    case 'figure': return b.md
  }
}

export function docsMarkdown(ids: DocIds): string {
  const sections = docsSections(ids)
  const out = [
    `# ${BRAND.name}: ${DOCS_TITLE.toLowerCase()}`,
    '',
    DOCS_LEDE,
    '',
    `This is the plain-text copy of ${SITE_URL}/docs/. Whitepaper: ${WHITEPAPER_URL}. Code and setup: ${README_URL}.`,
    '',
    '## Contents',
    '',
    ...sections.map((s, i) => `${i + 1}. [${s.title}](#${s.id})`),
    '',
  ]
  for (const s of sections) {
    out.push(`<a id="${s.id}"></a>`, '', `## ${s.title}`, '')
    for (const b of s.blocks) out.push(block(b), '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

export function llmsTxt(): string {
  return [
    `# ${BRAND.name}`,
    '',
    `> ${BRAND.explainer} Conditional "verse" tokens for every possible world of one to three real events, world pools and an order book, worst-world lending in three tiers, proposals that open markets from pledges, and resolution from public sources. Runs on NEAR testnet with test tokens.`,
    '',
    '## Docs',
    '',
    `- [The complete guide](${SITE_URL}/docs.md): every concept, number, screen, view and call, in plain Markdown`,
    `- [Whitepaper](${WHITEPAPER_URL}): the design in depth (PDF)`,
    `- [README](${README_URL}): accounts, setup, tests and deployment`,
    '',
    '## App',
    '',
    `- [Live site](${SITE_URL}/): markets, hedging, lending, proposals, resolution`,
    `- [How it works](${SITE_URL}/docs/): the same guide as a web page, with live numbers`,
    '',
  ].join('\n')
}
