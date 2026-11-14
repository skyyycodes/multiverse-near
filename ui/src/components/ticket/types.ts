// What the market page's ticket hands each of its panes: the market, and the worlds picked on its grid (a mask in
// contract bit order; 0 when none). The page (markets track) owns the ticket and its tabs; each pane belongs to the
// track that owns its flow (ui/INTEGRATION.md).
import type { ChainMarket } from '../../chain/adapter'

export type PaneProps = { market: ChainMarket; mask: number }
