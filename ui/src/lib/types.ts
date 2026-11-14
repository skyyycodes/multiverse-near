// Shapes of the data the site works with. The contracts will return these same shapes later.

// One yes/no event. A scenario fixes up to four of them; their combined outcomes are the worlds.
export type ScenarioEvent = {
  name: string // e.g. "The upgrade"
  outcomes: [string, string] // e.g. ["Ships", "Delayed"]; the first is bit value 0
  sources: [string, string] // the two independent sources the resolver agent checks
  image?: string // artwork for the event, under /public/markets
  rule?: string // exactly how the answer is decided, in plain words
  deadline?: string // when the answer is due, human date and time
}

// One world: one combined outcome of every event. Worlds are listed in bit order.
export type World = {
  id: string
  outcome: string // e.g. "Ships & cuts"
  chance: number // joint odds from the between-world pools, 0 to 1
  nearPrice: number // reference NEAR price inside this world, set by its pool
}

export type Market = {
  id: string
  question: string
  category: string
  resolves: string // human date
  events: ScenarioEvent[] // 1 to 4 events, so 2 to 16 worlds
  worlds: World[] // 2 ** events.length worlds, in bit order
  description?: string // one or two sentences on why the market matters
  tags?: string[] // short labels for filtering, e.g. "NEAR", "Rates"
  volume?: number // USDC traded across its world pools so far (demo figure until it is read from chain)
  opened?: string // when the owner opened it, human date
  // demo only: outcomes already settled when the site loads, as [event index, outcome index]
  settled?: [number, number][]
}
