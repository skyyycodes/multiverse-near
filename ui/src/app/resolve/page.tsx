'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Resolve'

// /resolve/?id=N: every market's events, or one market's (under Suspense: the view reads its query string)
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('id') ?? undefined} />} />
}
