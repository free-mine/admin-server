import type { Token } from './types.js'

export const CHAIN_ID = 43114
export const DEPLOYMENT_TX = '0x55f4fc48647fc41b96fb52125d11427473c215d76bac672b261f159c3f46d42d'
export const addresses = {
  oreVein: '0xe757a8b1d003BC8704dE110C8458b5358dB12070',
  freeMine: '0x5A2bA936848220F0cb7a4C3b961612674C135168',
  aave: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  lfjRouter: '0x18556DA13313f3532c54711497A8FedAC273220E',
  lfjQuoter: '0x9A550a522BBaDFB69019b0432800Ed17855A51C3',
  uniswapFactory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
  uniswapPositionManager: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
} as const
export const tokens: readonly Token[] = [
  { symbol: 'WAVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18 },
  { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
  { symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  { symbol: 'BTC.b', address: '0x152b9d0FdC40C096757F570A51E494bd4b943E50', decimals: 8 },
]
