import type { Chain } from '../chain/index.js'
import type { Config } from '../config/index.js'
import type { Operations, Previews } from '../operations/index.js'
import type { Successors } from '../successors/index.js'
export interface Services { config: Config; chain: Chain; operations: Operations; previews: Previews; successors: Successors }
