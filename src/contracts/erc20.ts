// Только используемые приложением методы ERC-20; ABI не зависит от отдельного пакета.
export const erc20Abi = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
