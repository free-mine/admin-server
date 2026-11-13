import type { Action } from '../requests/index.js'

export type FundAction = Extract<
  Action,
  { kind: 'contract.setURI' | `fund.${string}` }
>
