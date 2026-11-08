// Только локальный форк: сценарий проверяет hardhat_metadata до первой записи.
module.exports = {
  networks: {
    hardhat: {
      chainId: 43114,
      hardfork: 'cancun',
      chains: { 43114: { hardforkHistory: { cancun: 0 } } },
      forking: { url: process.env.FORK_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc' },
      accounts: [],
      loggingEnabled: false,
    },
  },
  paths: { cache: '../.cache/hardhat' },
}
