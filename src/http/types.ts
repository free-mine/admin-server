import type { Chain } from '../chain/index.js'
import type { Config } from '../config/index.js'
import type { Successors } from '../successors/index.js'
import type { PublicState } from '../public-state/index.js'
import type { Journal, Previews, Operations } from '../operations/index.js'

export interface Services {
  chain: Chain
  config: Config
  journal: Journal
  previews: Previews
  operations: Operations
  successors: Successors
  publicState: PublicState
}
