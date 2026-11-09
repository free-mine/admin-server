import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import type { InterfaceAbi } from 'ethers'
import {
  Wallet,
  Contract,
  parseEther,
  MaxUint256,
  ZeroAddress,
  BrowserProvider,
  ContractFactory,
} from 'ethers'

import { Chain } from '../src/chain/index.js'
import type { Action } from '../src/requests/index.js'
import { tokens, addresses } from '../src/config/index.js'
import type { Call, Receipt } from '../src/chain/index.js'
import { previewRequestSchema } from '../src/requests/index.js'
import {
  prepareBurn,
  prepareClose,
  listPositions,
} from '../src/protocols/index.js'

const require = createRequire(import.meta.url)
const { createHardhatNetworkProvider } =
  require('hardhat/internal/hardhat-network/provider/provider.js') as typeof import('hardhat/internal/hardhat-network/provider/provider.js')

test('Uniswap withdrawals and NFT cleanup are independent on a local EVM', async t => {
  const accounts = [Wallet.createRandom(), Wallet.createRandom()]
  const evm = await createHardhatNetworkProvider(
    {
      hardfork: 'cancun',
      chainId: 43114,
      networkId: 43114,
      blockGasLimit: 30_000_000,
      minGasPrice: 0n,
      automine: true,
      intervalMining: 0,
      mempoolOrder: 'fifo',
      chains: new Map(),
      genesisAccounts: accounts.map(wallet => ({
        privateKey: wallet.privateKey,
        balance: parseEther('1000').toString(),
      })),
      allowUnlimitedContractSize: false,
      throwOnTransactionFailures: false,
      throwOnCallFailures: true,
      allowBlocksWithSameTimestamp: false,
      enableTransientStorage: false,
      enableRip7212: false,
    },
    { enabled: false },
  )
  const provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 })
  provider.pollingInterval = 10
  t.after(() => provider.destroy())
  const owner = await provider.getSigner(accounts[0].address)
  const contributor = await provider.getSigner(accounts[1].address)
  const deploy = async (
    artifact: { bytecode: string; abi: InterfaceAbi },
    args: unknown[] = [],
  ): Promise<Contract> => {
    const contract = await new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      owner,
    ).deploy(...args)
    await contract.waitForDeployment()
    return new Contract(await contract.getAddress(), artifact.abi, owner)
  }
  const erc20 = require('@uniswap/v2-core/build/ERC20.json')
  const tokenA = await deploy(erc20, [parseEther('1000000')])
  const tokenB = await deploy(erc20, [parseEther('1000000')])
  const factory = await deploy(
    require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'),
  )
  const manager = await deploy(
    require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'),
    [factory.target, tokenA.target, ZeroAddress],
  )

  // Только forwarding-семантика OreVein; Uniswap исполняет настоящий байткод.
  const compiled = JSON.parse(
    require('solc').compile(
      JSON.stringify({
        language: 'Solidity',
        sources: {
          'Holder.sol': {
            content: `pragma solidity ^0.8.26;
      contract Holder {
        address public owner = msg.sender;
        error CallFailed(bytes reason);
        function execute(address target, uint256 value, bytes calldata data) external returns(bytes memory) {
          require(msg.sender == owner);
          (bool success, bytes memory result) = target.call{value: value}(data);
          if (!success) revert CallFailed(result);
          return result;
        }
      }`,
          },
        },
        settings: {
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  )
  const artifact = compiled.contracts['Holder.sol'].Holder
  const holder = await deploy({
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  })
  const originalAddresses = { ...addresses }
  const originalTokens = structuredClone(tokens)
  t.after(() => {
    Object.assign(addresses, originalAddresses)
    tokens.forEach((token, index) =>
      Object.assign(token, originalTokens[index]),
    )
  })
  Object.assign(addresses, {
    oreVein: holder.target,
    uniswapFactory: factory.target,
    uniswapPositionManager: manager.target,
  })
  Object.assign(tokens[0], { address: tokenA.target, decimals: 18 })
  Object.assign(tokens[2], { address: tokenB.target, decimals: 18 })
  const [token0, token1] = [tokenA, tokenB].sort((a, b) =>
    BigInt(String(a.target)) < BigInt(String(b.target)) ? -1 : 1,
  )
  await (
    await manager.createAndInitializePoolIfNecessary(
      token0.target,
      token1.target,
      500,
      2n ** 96n,
    )
  ).wait()
  for (const token of [tokenA, tokenB]) {
    await (await token.approve(manager.target, MaxUint256)).wait()
    await (await token.transfer(contributor.address, parseEther('1'))).wait()
    await (
      await new Contract(token.target, erc20.abi, contributor).approve(
        manager.target,
        MaxUint256,
      )
    ).wait()
  }
  const latest = await provider.getBlock('latest')
  assert.ok(latest)
  const deadline = latest.timestamp + 3600
  const chain = {
    contract: (address: string, abi: InterfaceAbi) =>
      new Contract(address, abi, provider),
    tokenByAddress: async (address: string) => {
      const token = tokens.find(
        value => value.address.toLowerCase() === address.toLowerCase(),
      )
      assert.ok(token)
      return token
    },
    direct: Chain.prototype.direct,
    execute: Chain.prototype.execute,
  } as unknown as Chain
  const mint = async () => {
    await (
      await manager.mint({
        token0: token0.target,
        token1: token1.target,
        fee: 500,
        tickLower: -100,
        tickUpper: 100,
        amount0Desired: parseEther('10'),
        amount1Desired: parseEther('10'),
        amount0Min: 0,
        amount1Min: 0,
        recipient: holder.target,
        deadline,
      })
    ).wait()
    const count = await manager.balanceOf(holder.target)
    return String(await manager.tokenOfOwnerByIndex(holder.target, count - 1n))
  }
  const increase = async (tokenId: string) => {
    const other = new Contract(manager.target, manager.interface, contributor)
    await (
      await other.increaseLiquidity({
        tokenId,
        amount0Desired: 1000n,
        amount1Desired: 1000n,
        amount0Min: 0,
        amount1Min: 0,
        deadline,
      })
    ).wait()
  }
  const execute = async (call: Call): Promise<Receipt> => {
    const mined = await (
      await owner.sendTransaction({ ...call, gasLimit: 1_000_000n })
    ).wait()
    assert.ok(mined)
    assert.equal(mined.status, 1)
    return {
      hash: mined.hash,
      status: 1,
      fee: mined.fee.toString(),
      blockNumber: mined.blockNumber,
      logs: [],
    }
  }

  for (const added of [false, true]) {
    await t.test(
      added
        ? 'added liquidity survives while planned liquidity is withdrawn'
        : 'ordinary close keeps an empty NFT which can be burned separately',
      async () => {
        const tokenId = await mint()
        const action: Action = {
          kind: 'uniswap.close',
          params: { tokenId, slippageBps: 100 },
        }
        const plan = await prepareClose(chain, action.params, deadline)
        const liquidity = (await manager.positions(tokenId)).liquidity as bigint
        await provider.call({ ...plan.steps[0].call, from: owner.address })
        if (added) {
          await increase(tokenId)
        }
        const delta = (await manager.positions(tokenId)).liquidity - liquidity
        if (added) {
          assert.ok(delta > 0n)
        }
        const before = await Promise.all([
          token0.balanceOf(holder.target),
          token1.balanceOf(holder.target),
        ])
        const receipt = await execute(plan.steps[0].call)
        assert.equal((await manager.positions(tokenId)).liquidity, delta)
        assert.equal(await manager.ownerOf(tokenId), holder.target)
        assert.ok((await token0.balanceOf(holder.target)) > before[0])
        assert.ok((await token1.balanceOf(holder.target)) > before[1])
        const result = await Chain.prototype.readResult.call(
          chain,
          action,
          receipt,
        )
        assert.deepEqual(result, {
          tokenId,
          blockNumber: receipt.blockNumber,
          nftExists: true,
          liquidity: String(delta),
          tokensOwed0: '0',
          tokensOwed1: '0',
        })
        const listed = (await listPositions(chain)).positions.find(
          value => value.tokenId === tokenId,
        )
        assert.ok(listed && 'liquidity' in listed)
        assert.equal(listed.liquidity, String(delta))
        if (added) {
          await assert.rejects(
            prepareBurn(chain, { tokenId }),
            /POSITION_NOT_EMPTY/,
          )
          // Результат относится к блоку вывода, а не к состоянию при чтении API.
          await increase(tokenId)
          assert.deepEqual(
            await Chain.prototype.readResult.call(chain, action, receipt),
            result,
          )
        } else {
          const burnRequest = previewRequestSchema.parse({
            action: { kind: 'uniswap.burn', params: { tokenId } },
            maxGasAvax: '0.01',
          })
          const burn = await prepareBurn(chain, { tokenId })
          const burned = await execute(burn.steps[0].call)
          await assert.rejects(manager.ownerOf(tokenId))
          assert.deepEqual(
            await Chain.prototype.readResult.call(
              chain,
              burnRequest.action,
              burned,
            ),
            { tokenId, blockNumber: burned.blockNumber, nftExists: false },
          )
        }
      },
    )
  }

  await t.test(
    'a stale burn can revert without undoing a successful withdrawal',
    async () => {
      const tokenId = await mint()
      const close = await prepareClose(
        chain,
        { tokenId, slippageBps: 100 },
        deadline,
      )
      await execute(close.steps[0].call)
      // Повторное закрытие уже пустой позиции тоже допустимо.
      const empty = await prepareClose(
        chain,
        { tokenId, slippageBps: 100 },
        deadline,
      )
      await execute(empty.steps[0].call)
      const burn = await prepareBurn(chain, { tokenId })
      await provider.call({ ...burn.steps[0].call, from: owner.address })
      await increase(tokenId)
      const before = await Promise.all([
        token0.balanceOf(holder.target),
        token1.balanceOf(holder.target),
      ])
      const transaction = await owner.sendTransaction({
        ...burn.steps[0].call,
        gasLimit: 1_000_000n,
      })
      await assert.rejects(transaction.wait(), error => {
        assert.equal(
          (error as { receipt: { status: number } }).receipt.status,
          0,
        )
        return true
      })
      assert.deepEqual(
        await Promise.all([
          token0.balanceOf(holder.target),
          token1.balanceOf(holder.target),
        ]),
        before,
      )
      assert.equal(await manager.ownerOf(tokenId), holder.target)
    },
  )
})
