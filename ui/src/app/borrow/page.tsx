'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Borrow'

// under Suspense, so the view may read its query string (?id=N, ?tier=…, ?w=…)
export default function Page() {
  return <RoutePage render={() => <View />} />
}
