// public/docs.md and public/llms.txt are the guide's agent-readable copies. They are written from the same data the
// /docs/ page renders; this test fails when they drift. Rewrite them with `pnpm docs:md`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { networkEnv } from '../../scripts/network.mjs'
import { links } from '../config'
import { WHITEPAPER_URL, docsSections, type Block } from './content'
import { docsMarkdown, llmsTxt } from './markdown'

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url))
// the copies describe the live deployment: staging, as the hosted site is built (build:staging)
const env = networkEnv('staging', {})
const ids = { contract: env.NEXT_PUBLIC_CONTRACT_ID, wnear: env.NEXT_PUBLIC_WNEAR_ID, usdc: env.NEXT_PUBLIC_USDC_ID }
const FILES: [string, string][] = [['docs.md', docsMarkdown(ids)], ['llms.txt', llmsTxt()]]

if (process.env.WRITE_DOCS === '1') for (const [name, text] of FILES) writeFileSync(`${PUBLIC}${name}`, text)

describe('the agent-readable docs', () => {
  it.each(FILES)('public/%s matches the page', (name, text) => {
    expect(existsSync(`${PUBLIC}${name}`), `${name} is missing: run pnpm docs:md`).toBe(true)
    expect(readFileSync(`${PUBLIC}${name}`, 'utf8'), `${name} is stale: run pnpm docs:md`).toBe(text)
  })

  it('names the staging deployment, never another', () => {
    const md = docsMarkdown(ids)
    expect(ids.contract).toBe('app.ifverse-staging.testnet')
    expect(md).toContain('app.ifverse-staging.testnet')
    expect(md).not.toMatch(/multiverse-near\.testnet/)
  })

  it('has unique section ids and only the three inline marks', () => {
    const sections = docsSections(ids)
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length)
    const texts = sections.flatMap((s) => s.blocks.flatMap((b: Block) => (b.type === 'p' || b.type === 'note' ? [b.text] : b.type === 'list' ? b.items : [])))
    // an unbalanced ** or ` would print literally on the page
    for (const t of texts) {
      expect((t.match(/\*\*/g) ?? []).length % 2, t).toBe(0)
      expect((t.match(/`/g) ?? []).length % 2, t).toBe(0)
    }
  })

  it('points llms.txt at the guide, the whitepaper and the README', () => {
    const t = llmsTxt()
    expect(t).toContain('/docs.md')
    expect(t).toContain(WHITEPAPER_URL)
    expect(t).toContain('README.md')
  })

  it('links a whitepaper that public/ serves', () => {
    // a local path must name a file in public/, or every Whitepaper link on the site is a 404
    if (links.whitepaper.startsWith('/')) expect(existsSync(`${PUBLIC}${links.whitepaper.slice(1)}`), links.whitepaper).toBe(true)
  })
})
