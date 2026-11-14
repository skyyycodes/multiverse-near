'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Admin'

// /admin/?id=N: the owner console, its market blocks on market N (under Suspense: the view reads its query string)
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('id') ?? undefined} />} />
}
