'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Split'

// /split/?id=N: split real wNEAR or USDC into every world of market N, or merge a full set back
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('id') ?? ''} />} />
}
