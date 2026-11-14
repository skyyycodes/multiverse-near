/**
 * Every user-facing brand string, and the only place they live (WI-7; `brand.test.ts` fails on a stray one). Code names
 * are not brand and stay as they are: the wallet id `multiverse-demo`, the storage keys `multiverse.welcomed` and
 * `ifverse.*`, the NEP-297 standard `multiverse`, the rule tags `[ifverse:…]`, crate names, every account id
 * (`*.ifverse-staging.testnet`) and the site address. The earlier names (IfVerse, Multiverse Lending) are not shown,
 * so none is kept here: whatever is in this object ships in the bundle.
 */
export const BRAND = {
  name: "Origami Verse",
  slug: "origami-verse",
  headline: "What if your what-ifs became worlds?",
  subline: "A multiverse for the real world.",
  explainer: "Hold NEAR in the futures you like and dollars in the ones you fear.",
  short: "Every what-if gets its own world.",
  innerBalance: "In Origami Verse",
  credit: {
    text: "The idea of splitting assets into verses comes from Paradigm's Multiverse Finance essay (Dave White, May 2025)",
    url: "https://www.paradigm.xyz/2025/05/multiverse-finance",
  },
  testnetNote: "Runs on NEAR testnet. Test tokens have no value.",
} as const;
