import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { BRAND } from '../chain/brand'

// Each route's browser-tab title ("Markets · Origami Verse"), set by a pass-through layout per route folder, since the pages
// themselves are client components and cannot export metadata.
export const titled = (page: string): Metadata => ({ title: `${page} · ${BRAND.name}` })

export function PassThrough({ children }: { children: ReactNode }) {
  return children
}
