export interface Token { symbol: string; address: string; decimals: number }
export interface Config {
  rpcUrl: string; privateKey: string; host: string; port: number; dataDir: string
  allowedOrigins: string[]; logBlockRange: number; deploymentBlock?: number
  pollMs: number; previewTtlSeconds: number; rpcTimeoutMs: number
}
