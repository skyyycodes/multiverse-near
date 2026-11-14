// Site-wide settings. Change a value here and it updates everywhere on the site.

export const site = {
  name: 'Origami Verse',
  tagline: 'Keep NEAR in the worlds you like, hold dollars in the worlds you fear, and borrow against everything at once.',
  hero: {
    struck: 'One future.',
    headline: 'Every future.',
    sub: 'Hold NEAR in the futures you like and dollars in the futures you fear, then borrow real USDC against your worst world.',
  },
}

export const nav = [
  { to: '/markets', label: 'Markets' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/borrow', label: 'Borrow' },
  { to: '/lend', label: 'Lend' },
  { to: '/orders', label: 'Order book' },
  { to: '/resolve', label: 'Resolve' },
  { to: '/docs', label: 'How it works' },
]

export const links = {
  github: 'https://github.com/skyyycodes/multiverse-near',
  learn: 'https://github.com/skyyycodes/multiverse-near/blob/main/docs/LEARN.md',
  roadmap: 'https://github.com/skyyycodes/multiverse-near/blob/main/docs/ROADMAP.md',
  paper: 'https://www.paradigm.xyz/2025/05/multiverse-finance',
  near: 'https://near.org',
  nearDocs: 'https://docs.near.org',
}

// Where the contracts live. With no core contract set, the site runs on the in-browser model
// (lib/scenario.ts) through the mock client; set these to switch to testnet.
export const chain = {
  network: (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  rpc: process.env.NEXT_PUBLIC_NEAR_RPC ?? 'https://rpc.testnet.near.org',
  core: process.env.NEXT_PUBLIC_CORE_CONTRACT ?? '', // verse, amm, lending, router, futarchy
  resolver: process.env.NEXT_PUBLIC_RESOLVER_CONTRACT ?? '',
  usdc: process.env.NEXT_PUBLIC_USDC_CONTRACT ?? '', // vault-mock test USDC (NEP-141)
  wnear: process.env.NEXT_PUBLIC_WNEAR_CONTRACT ?? '', // vault-mock wNEAR (NEP-141)
}
