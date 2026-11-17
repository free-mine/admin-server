export interface Token {
  symbol: string
  address: string
  decimals: number
}
export interface Config {
  host: string
  rpcUrl: string
  pollMs: number
  panelPin: string
  privateKey?: string
  rpcTimeoutMs: number
  allowedDomain: string
  logBlockRange: number
  deploymentBlock?: number
  previewTtlSeconds: number
}
