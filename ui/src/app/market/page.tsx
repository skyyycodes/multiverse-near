'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Market'

// /market/?id=N: one market, read client-side (the static export has no per-market pages)
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('id') ?? ''} />} />
}
