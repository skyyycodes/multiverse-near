'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/Proposal'

// /proposal/?p=N: one market proposal, its pledges and its opening
export default function Page() {
  return <RoutePage render={(q) => <View id={q.get('p') ?? ''} />} />
}
