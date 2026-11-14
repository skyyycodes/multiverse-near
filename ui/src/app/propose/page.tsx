'use client'
import { RoutePage } from '../../components/layout/RoutePage'
import View from '../../views/CreateMarket'

// /propose/: propose a new event or a market of events (?kind=event|market, ?events=1,2)
export default function Page() {
  return <RoutePage render={() => <View />} />
}
