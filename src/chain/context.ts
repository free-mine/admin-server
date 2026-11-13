import type { InterfaceAbi } from 'ethers'
import {
  Wallet,
  Contract,
  Interface,
  Transaction,
  ZeroAddress,
  formatEther,
  FetchRequest,
  JsonRpcProvider,
} from 'ethers'

import type { Action } from '../requests/index.js'
import type { JsonObject } from '../shared/index.js'
import type { Token, Config } from '../config/index.js'
import { mintAmountsAtPrice } from '../liquidity/index.js'
import { tokens, CHAIN_ID, addresses } from '../config/index.js'
import { ensure, AppError, sameAddress } from '../shared/index.js'
import type {
  Call,
  Guard,
  Receipt,
  Approval,
  SignedTransaction,
  TransactionTransport,
} from './types.js'
import {
  erc20Abi,
  oreVeinAbi,
  freeMineAbi,
  uniswapPoolAbi,
  uniswapFactoryAbi,
  positionManagerAbi,
} from '../contracts/index.js'

const oreInterface = new Interface(oreVeinAbi)
const tokenInterface = new Interface(erc20Abi)

export class Chain implements TransactionTransport {
  readonly oreVein: Contract
  readonly freeMine: Contract
  private readonly checkedTokens = new Set<string>()

  private constructor(
    readonly provider: JsonRpcProvider,
    readonly owner: string,
    private readonly wallet?: Wallet,
  ) {
    this.oreVein = this.contract(addresses.oreVein, oreVeinAbi)
    this.freeMine = this.contract(addresses.freeMine, freeMineAbi)
  }

  static async connect(config: Config): Promise<Chain> {
    const request = new FetchRequest(config.rpcUrl)
    request.timeout = config.rpcTimeoutMs
    const provider = new JsonRpcProvider(request, undefined, {
      batchMaxCount: 1,
      cacheTimeout: -1,
    })
    try {
      const owner: string = await new Contract(
        addresses.oreVein,
        oreVeinAbi,
        provider,
      ).owner()
      let wallet: Wallet | undefined
      if (config.privateKey) {
        try {
          const candidate = new Wallet(config.privateKey, provider)
          if (sameAddress(candidate.address, owner)) {
            wallet = candidate
          }
        } catch {
          // Непригодный ключ оставляет доступными чтение и симуляции.
        }
      }
      const chain = new Chain(provider, owner, wallet)
      await chain.assertAvailable()
      return chain
    } catch (error) {
      provider.destroy()
      throw error
    }
  }

  get readOnly(): boolean {
    return this.wallet === undefined
  }

  contract(address: string, abi: InterfaceAbi): Contract {
    return new Contract(address, abi, this.provider)
  }

  async assertAvailable(): Promise<void> {
    ensure(
      BigInt(await this.provider.send('eth_chainId', [])) === BigInt(CHAIN_ID),
      'WRONG_NETWORK',
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

  async assertOwner(): Promise<void> {
    if (this.readOnly) {
      throw new AppError('READ_ONLY', 403)
    }
    await this.assertAvailable()
    ensure(
      sameAddress(await this.oreVein.owner(), this.owner),
      'OWNER_MISMATCH',
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
      if (guard.contract === 'uniswapPool') {
        const factory = this.contract(
          addresses.uniswapFactory,
          uniswapFactoryAbi,
        )
        const address: string = await factory.getPool(
          guard.token0,
          guard.token1,
          guard.fee,
        )
        let price =
          address === ZeroAddress
            ? 0n
            : BigInt(
                (await this.contract(address, uniswapPoolAbi).slot0())
                  .sqrtPriceX96,
              )
        if (price === 0n && guard.initialSqrtPriceX96 !== undefined) {
          price = BigInt(guard.initialSqrtPriceX96)
        }
        ensure(
          price >= BigInt(guard.minimumSqrtPriceX96) &&
            price <= BigInt(guard.maximumSqrtPriceX96),
          'PLAN_CHANGED',
        )
        const expected = mintAmountsAtPrice(
          price,
          guard.tickLower,
          guard.tickUpper,
          BigInt(guard.amount0Desired),
          BigInt(guard.amount1Desired),
        )
        ensure(
          expected.expected0 * 100n >= BigInt(guard.budget0) * 99n &&
            expected.expected1 * 100n >= BigInt(guard.budget1) * 99n,
          'PLAN_CHANGED',
        )
        continue
      }
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
    const wallet = this.wallet
    if (!wallet) {
      throw new AppError('READ_ONLY', 403)
    }
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
    const request = await wallet.populateTransaction({
      ...call,
      chainId: CHAIN_ID,
      gasLimit: estimate.gasLimit,
      maxFeePerGas: estimate.maxFeePerGas,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
      type: 2,
    })
    const raw = await wallet.signTransaction(request)
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
    await this.assertOwner()
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
  async readResult(
    action: Action,
    receipt: Receipt,
  ): Promise<JsonObject | undefined> {
    if (action.kind === 'uniswap.burn') {
      return {
        tokenId: action.params.tokenId,
        blockNumber: receipt.blockNumber,
        nftExists: false,
      }
    }
    if (action.kind !== 'uniswap.close') {
      return undefined
    }
    const manager = this.contract(
      addresses.uniswapPositionManager,
      positionManagerAbi,
    )
    const position = await manager.positions(action.params.tokenId, {
      blockTag: receipt.blockNumber,
    })
    return {
      tokenId: action.params.tokenId,
      blockNumber: receipt.blockNumber,
      nftExists: true,
      liquidity: String(position.liquidity),
      tokensOwed0: String(position.tokensOwed0),
      tokensOwed1: String(position.tokensOwed1),
    }
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
