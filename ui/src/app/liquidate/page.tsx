'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Liquidate'

// /liquidate/: at-risk loans across markets and tiers (?id=N narrows to one market)
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('id') ?? ''} />} />
}
