export interface Token {
  symbol: string
  address: string
  decimals: number
}
export interface Config {
  host: string
  port: number
  rpcUrl: string
  pollMs: number
  dataDir: string
  privateKey: string
  rpcTimeoutMs: number
  logBlockRange: number
  allowedOrigins: string[]
  deploymentBlock?: number
  previewTtlSeconds: number
}
