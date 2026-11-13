export interface Token {
  symbol: string
  address: string
  decimals: number
}
export interface Config {
  host: string
  rpcUrl: string
  pollMs: number
  privateKey?: string
  rpcTimeoutMs: number
  logBlockRange: number
  syncIntervalMs: number
  publicServerUrl: string
  deploymentBlock?: number
  publicServerKey?: string
  previewTtlSeconds: number
  publicServerTimeoutMs: number
}
