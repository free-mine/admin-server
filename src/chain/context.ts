import type { InterfaceAbi } from 'ethers'
import {
  Wallet,
  Contract,
  Interface,
  Transaction,
  formatEther,
  FetchRequest,
  JsonRpcProvider,
} from 'ethers'

import type { Token, Config } from '../config/index.js'
import { ensure, sameAddress } from '../shared/index.js'
import { tokens, CHAIN_ID, addresses } from '../config/index.js'
import { erc20Abi, oreVeinAbi, freeMineAbi } from '../contracts/index.js'
import type {
  Call,
  Guard,
  Receipt,
  Approval,
  SignedTransaction,
  TransactionTransport,
} from './types.js'

const oreInterface = new Interface(oreVeinAbi)
const tokenInterface = new Interface(erc20Abi)

export class Chain implements TransactionTransport {
  readonly provider: JsonRpcProvider
  readonly wallet: Wallet
  readonly owner: string
  readonly oreVein: Contract
  readonly freeMine: Contract
  private readonly checkedTokens = new Set<string>()

  constructor(config: Config) {
    const request = new FetchRequest(config.rpcUrl)
    request.timeout = config.rpcTimeoutMs
    this.provider = new JsonRpcProvider(request, undefined, {
      batchMaxCount: 1,
      cacheTimeout: -1,
    })
    this.wallet = new Wallet(config.privateKey, this.provider)
    this.owner = this.wallet.address
    this.oreVein = this.contract(addresses.oreVein, oreVeinAbi)
    this.freeMine = this.contract(addresses.freeMine, freeMineAbi)
  }

  contract(address: string, abi: InterfaceAbi): Contract {
    return new Contract(address, abi, this.provider)
  }

  async assertOwner(): Promise<void> {
    ensure(
      BigInt(await this.provider.send('eth_chainId', [])) === BigInt(CHAIN_ID),
      'WRONG_NETWORK',
    )
    ensure(
      sameAddress(await this.oreVein.owner(), this.owner),
      'OWNER_MISMATCH',
    )
    ensure(
      sameAddress(await this.oreVein.freeMine(), addresses.freeMine),
      'FREEMINE_MISMATCH',
    )
    ensure(
      sameAddress(await this.freeMine.owner(), addresses.oreVein),
      'FREEMINE_OWNER_MISMATCH',
    )
  }

  async token(symbol: string): Promise<Token> {
    const token = tokens.find(t => t.symbol === symbol)
    ensure(token, 'UNSUPPORTED_TOKEN')
    if (!this.checkedTokens.has(symbol)) {
      ensure(
        Number(await this.contract(token.address, erc20Abi).decimals()) ===
          token.decimals,
        'TOKEN_DECIMALS_MISMATCH',
      )
      this.checkedTokens.add(symbol)
    }
    return token
  }
  async tokenByAddress(address: string): Promise<Token> {
    const token = tokens.find(t => sameAddress(t.address, address))
    ensure(token, 'UNSUPPORTED_TOKEN')
    return this.token(token.symbol)
  }
  async balance(token: Token): Promise<bigint> {
    return BigInt(
      await this.contract(token.address, erc20Abi).balanceOf(addresses.oreVein),
    )
  }
  async assertBalance(token: Token, value: bigint): Promise<void> {
    ensure((await this.balance(token)) >= value, 'INSUFFICIENT_TOKEN_BALANCE')
  }
  async allowance(approval: Approval): Promise<bigint> {
    return BigInt(
      await this.contract(approval.token, erc20Abi).allowance(
        addresses.oreVein,
        approval.spender,
      ),
    )
  }
  direct(method: string, args: readonly unknown[]): Call {
    return {
      to: addresses.oreVein,
      value: '0',
      data: oreInterface.encodeFunctionData(method, args),
    }
  }
  execute(
    target: string,
    abi: InterfaceAbi,
    method: string,
    args: readonly unknown[],
  ): Call {
    const allowed = [
      addresses.aave,
      addresses.lfjRouter,
      addresses.uniswapPositionManager,
      ...tokens.map(t => t.address),
    ]
    ensure(
      allowed.some(address => sameAddress(address, target)),
      'UNSUPPORTED_TARGET',
    )
    return this.direct('execute', [
      target,
      0n,
      new Interface(abi).encodeFunctionData(method, args),
    ])
  }
  async simulate(call: Call): Promise<string> {
    return this.provider.call({ ...call, from: this.owner })
  }
  async validate(guards: Guard[]): Promise<void> {
    for (const guard of guards) {
      const contract =
        guard.contract === 'oreVein' ? this.oreVein : this.freeMine
      const current = String(
        await contract.getFunction(guard.method)(...guard.args),
      )
      ensure(
        current.toLowerCase() === guard.expected.toLowerCase(),
        'PLAN_CHANGED',
      )
    }
  }
  async estimate(call: Call): Promise<{
    maxCost: bigint
    gasLimit: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }> {
    const gas = await this.provider.estimateGas({ ...call, from: this.owner })
    const fee = await this.provider.getFeeData()
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice
    ensure(maxFeePerGas != null, 'GAS_PRICE_UNAVAILABLE')
    const gasLimit = (gas * 120n + 99n) / 100n
    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
      maxCost: gasLimit * maxFeePerGas,
    }
  }
  async sign(
    call: Call,
    remainingGas: bigint,
    approval?: Approval,
  ): Promise<SignedTransaction> {
    ensure(
      sameAddress(call.to, addresses.oreVein) && call.value === '0',
      'INVALID_CALL',
    )
    await this.assertOwner()
    const result = await this.simulate(call)
    if (approval) {
      const [inner] = oreInterface.decodeFunctionResult('execute', result)
      // SafeERC20 допускает пустой результат, но не false.
      if (inner !== '0x') {
        ensure(
          tokenInterface.decodeFunctionResult('approve', inner)[0] === true,
          'APPROVAL_REFUSED',
        )
      }
    }
    const estimate = await this.estimate(call)
    ensure(estimate.maxCost <= remainingGas, 'GAS_BUDGET_EXCEEDED')
    ensure(
      (await this.provider.getBalance(this.owner)) >= estimate.maxCost,
      'INSUFFICIENT_GAS_BALANCE',
    )
    const request = await this.wallet.populateTransaction({
      ...call,
      chainId: CHAIN_ID,
      gasLimit: estimate.gasLimit,
      maxFeePerGas: estimate.maxFeePerGas,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
      type: 2,
    })
    const raw = await this.wallet.signTransaction(request)
    const tx = Transaction.from(raw)
    ensure(tx.hash, 'SIGNING_FAILED')
    return {
      raw,
      hash: tx.hash,
      nonce: tx.nonce,
      maxFee: estimate.maxCost.toString(),
    }
  }
  async broadcast(raw: string): Promise<void> {
    await this.provider.broadcastTransaction(raw)
  }
  async receipt(hash: string): Promise<Receipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash)
    if (!receipt) {
      return null
    }
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status ?? 0,
      fee: receipt.fee.toString(),
      logs: receipt.logs.map(log => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
    }
  }
  async nonce(): Promise<number> {
    return this.provider.getTransactionCount(this.owner, 'latest')
  }
  async replacement(
    hash: string,
    signed: SignedTransaction,
  ): Promise<{ receipt: Receipt; matches: boolean }> {
    const [transaction, receipt] = await Promise.all([
      this.provider.getTransaction(hash),
      this.receipt(hash),
    ])
    ensure(transaction && receipt, 'REPLACEMENT_NOT_CONFIRMED')
    ensure(
      sameAddress(transaction.from, this.owner) &&
        transaction.nonce === signed.nonce,
      'REPLACEMENT_MISMATCH',
    )
    const original = Transaction.from(signed.raw)
    return {
      receipt,
      matches:
        transaction.to === original.to &&
        transaction.data === original.data &&
        transaction.value === original.value,
    }
  }
  async balances() {
    return {
      owner: this.owner,
      ownerAvax: formatEther(await this.provider.getBalance(this.owner)),
      oreVein: addresses.oreVein,
      oreVeinAvax: formatEther(
        await this.provider.getBalance(addresses.oreVein),
      ),
      tokens: await Promise.all(
        tokens.map(async metadata => {
          const token = await this.token(metadata.symbol)
          return { ...token, balance: (await this.balance(token)).toString() }
        }),
      ),
    }
  }
  dispose(): void {
    this.provider.destroy()
  }
}
