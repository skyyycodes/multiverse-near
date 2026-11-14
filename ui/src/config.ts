// Site-wide settings. Change a value here and it updates everywhere on the site.
import { BRAND } from './chain/brand'
import { ENV } from './chain/env'

export const site = {
  name: BRAND.name,
  tagline: 'Keep NEAR in the worlds you like, hold dollars in the worlds you fear, and borrow against everything at once.',
  hero: {
    struck: 'One future.',
    headline: 'Every future.',
    sub: 'Hold NEAR in the futures you like and dollars in the futures you fear, then borrow real USDC against your worst world.',
  },
}

export const links = {
  github: 'https://github.com/skyyycodes/multiverse-near',
  learn: 'https://github.com/skyyycodes/multiverse-near/blob/main/docs/LEARN.md',
  roadmap: 'https://github.com/skyyycodes/multiverse-near/blob/main/docs/ROADMAP.md',
  paper: BRAND.credit.url,
  /** The whitepaper, opened in a new tab from the header's How it works menu and the footer. One constant: a hosted
   *  copy (a Drive link) can replace the file in public/ here. */
  whitepaper: '/ifverse-whitepaper.pdf',
  near: 'https://near.org',
  nearDocs: 'https://docs.near.org',
}

/** One entry of a header dropdown; `external` opens in a new tab (a file such as the whitepaper). */
export type NavSub = { href: string; label: string; note: string; external?: boolean }
export type NavItem = { to: string; label: string; also?: string[]; menu?: NavSub[] }

// The header's links, in order. `also`: other screens the link stays underlined on (a market's own pages, a proposal).
export const nav: NavItem[] = [
  { to: '/markets/', label: 'Markets', also: ['/market/', '/split/'] },
  { to: '/portfolio/', label: 'Portfolio' },
  { to: '/borrow/', label: 'Borrow' },
  { to: '/lend/', label: 'Lend' },
  { to: '/orders/', label: 'Order book' },
  { to: '/propose/', label: 'Propose', also: ['/proposal/', '/proposals/'] },
  { to: '/resolve/', label: 'Resolve' },
  {
    to: '/docs/',
    label: 'How it works',
    menu: [
      { href: '/docs/', label: 'Docs', note: 'The complete guide, in plain words' },
      { href: links.whitepaper, label: 'Whitepaper', note: 'The design in depth (PDF)', external: true },
    ],
  },
]

const bare = (p: string) => (p.replace(/\/+$/, '') || '/')

/** Whether the header underlines `item` on `path` (with or without the trailing slash). */
export function isCurrent(path: string | null, item: NavItem): boolean {
  const p = bare(path ?? '/')
  return [item.to, ...(item.also ?? [])].some((to) => {
    const t = bare(to)
    return p === t || p.startsWith(`${t}/`)
  })
}

// Screens reached in context (from a market, a loan, the wallet menu), also listed in the footer.
export const footerLinks: { to: string; label: string }[] = [
  { to: '/markets/', label: 'Markets' },
  { to: '/portfolio/', label: 'Portfolio' },
  { to: '/liquidate/', label: 'At-risk loans' },
  { to: '/propose/', label: 'Propose a market' },
  { to: '/proposals/', label: 'Proposals' },
  { to: '/decision-markets/', label: 'Decision markets' },
  { to: '/docs/', label: 'How it works' },
  { to: '/admin/', label: 'Admin' },
]


// Where the contracts live: the deployment this build was made for (deployments/<network>.json, read by
// next.config.ts). Read chain ids from here or from ENV, never as literals.
export const chain = {
  network: ENV.network,
  contractId: ENV.contractId,
  wnear: ENV.wnearId,
  usdc: ENV.usdcId,
  explorer: ENV.explorer,
  /** The anchor market: SPICE × Fed, the one the header's world grid shows. */
  anchorMarket: 1,
}
