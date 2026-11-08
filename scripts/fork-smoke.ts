import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Contract, FetchRequest, JsonRpcProvider, JsonRpcSigner, Wallet, formatUnits, parseEther, ZeroAddress } from 'ethers'
import { WebSocket } from 'ws'
import { addresses, CHAIN_ID, tokens } from '../src/config/index.js'
import { erc20Abi, freeMineAbi, oreVeinAbi, lfjQuoterAbi, positionManagerAbi, uniswapFactoryAbi } from '../src/contracts/index.js'
import type { Action } from '../src/requests/index.js'
import type { OperationView } from '../src/operations/index.js'

// Адрес намеренно не читается из пользовательского окружения.
const LOCAL_RPC = 'http://127.0.0.1:18545'
const BASE = 'http://127.0.0.1:18080'
const request = new FetchRequest(LOCAL_RPC)
request.timeout = 600000
const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 })
const suffix = randomUUID().slice(0, 8)
const containerName = `ore-vein-test-${suffix}`
const volumeName = `ore-vein-test-data-${suffix}`
const cache = resolve('.cache')
mkdirSync(cache, { recursive: true })
const temporary = mkdtempSync(join(cache, 'fork-'))
let snapshot: string | undefined
let containerCreated = false, volumeCreated = false
let socket: WebSocket | undefined
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim()
const updates: OperationView[] = []

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000) })
  const data: unknown = await response.json()
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`)
  return data as T
}
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/ready', { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* Сервер запускается. */ }
    await delay(500)
  }
  console.log(docker('logs', '--tail', '20', containerName))
  throw new Error('Container did not become ready')
}
async function waitOperation(id: string): Promise<OperationView> {
  for (let i = 0; i < 180; i++) {
    const operation = await api<OperationView>(`/v1/operations/${id}`)
    if (operation.status === 'succeeded') return operation
    assert.ok(!['failed', 'needs_attention'].includes(operation.status), JSON.stringify(operation))
    await delay(500)
  }
  throw new Error(`Operation timeout: ${id}`)
}
async function order(action: Action): Promise<OperationView> {
  const preview = await api<{ id: string }>('/v1/previews', { action, maxGasAvax: '1' })
  const input = { previewId: preview.id, requestId: randomUUID() }
  const operation = await api<OperationView>('/v1/operations', input)
  const repeated = await api<OperationView>('/v1/operations', input)
  assert.equal(repeated.id, operation.id)
  const result = await waitOperation(operation.id)
  console.log(`PASS ${action.kind}: ${result.steps.map(step => `${step.code}=${step.status}`).join(', ')}`)
  assert.ok(!JSON.stringify(result).includes('"raw"'))
  return result
}

try {
  const [version, metadata] = await Promise.all([
    provider.send('web3_clientVersion', []), provider.send('hardhat_metadata', []),
  ])
  assert.match(version, /Hardhat/i)
  assert.equal(Number(metadata.chainId), CHAIN_ID)
  assert.equal(Number(metadata.forkedNetwork?.chainId), CHAIN_ID)
  snapshot = await provider.send('evm_snapshot', [])
  await provider.send('evm_mine', [])
  console.log('Verified local Hardhat Avalanche fork; all following transactions stay on the fork.')

  console.log('SETUP read owner and prepare ephemeral fork wallet')
  const ore = new Contract(addresses.oreVein, oreVeinAbi, provider)
  const originalOwner: string = await ore.owner()
  await provider.send('hardhat_impersonateAccount', [originalOwner])
  await provider.send('hardhat_setBalance', [originalOwner, `0x${parseEther('1000').toString(16)}`])
  const originalSigner = new JsonRpcSigner(provider, originalOwner)
  const owner = Wallet.createRandom().connect(provider)
  await provider.send('hardhat_setBalance', [owner.address, `0x${parseEther('1000').toString(16)}`])
  await (await ore.connect(originalSigner).getFunction('transferOwnership')(owner.address)).wait()
  await (await ore.connect(owner).getFunction('acceptOwnership')()).wait()
  console.log('SETUP wrap WAVAX and fund OreVein on the fork')
  const wavax = new Contract(tokens[0].address, [
    'function deposit() payable', 'function transfer(address,uint256) returns(bool)',
  ], originalSigner)
  await (await wavax.deposit({ value: parseEther('20') })).wait()
  await (await wavax.transfer(addresses.oreVein, parseEther('20'))).wait()
  // Живой резерв WAVAX может исчерпать supply cap из-за процентов.
  // Только в форке убираем лимиты для воспроизводимого полного цикла Aave.
  const pool = new Contract(addresses.aave, ['function ADDRESSES_PROVIDER() view returns(address)'], provider)
  const addressProvider = new Contract(await pool.ADDRESSES_PROVIDER(), [
    'function getACLAdmin() view returns(address)', 'function getACLManager() view returns(address)',
    'function getPoolConfigurator() view returns(address)',
  ], provider)
  const aclAdmin: string = await addressProvider.getACLAdmin()
  await provider.send('hardhat_impersonateAccount', [aclAdmin])
  await provider.send('hardhat_setBalance', [aclAdmin, `0x${parseEther('100').toString(16)}`])
  const acl = new Contract(await addressProvider.getACLManager(), ['function addPoolAdmin(address)'], new JsonRpcSigner(provider, aclAdmin))
  await (await acl.addPoolAdmin(owner.address)).wait()
  const configurator = new Contract(await addressProvider.getPoolConfigurator(), [
    'function setSupplyCap(address,uint256)', 'function setBorrowCap(address,uint256)',
  ], owner)
  await (await configurator.setSupplyCap(tokens[0].address, 0n)).wait()
  await (await configurator.setSupplyCap(tokens[2].address, 0n)).wait()
  await (await configurator.setBorrowCap(tokens[2].address, 0n)).wait()
  console.log('FORK ONLY: removed WAVAX/USDC supply caps and USDC borrow cap')
  const quoter = new Contract(addresses.lfjQuoter, lfjQuoterAbi, provider)
  const [av, usdtMetadata, usdcMetadata, btc] = tokens
  const warmRoutes = [[av, usdcMetadata], [av, usdtMetadata, usdcMetadata], [av, btc, usdcMetadata],
    [av, usdtMetadata, btc, usdcMetadata], [av, btc, usdtMetadata, usdcMetadata]]
  for (const [index, route] of warmRoutes.entries()) {
    console.log(`WARM LFJ state ${index + 1}/${warmRoutes.length}`)
    try { await quoter.findBestPathFromAmountIn(route.map(token => token.address), parseEther('5')) }
    catch { /* Отсутствующий маршрут допустим; рабочий API проверит доступные котировки. */ }
  }
  const startBlock = await provider.getBlockNumber()
  const envFile = join(temporary, 'container.env')
  // Временный ключ существует только в форке и не выводится в консоль.
  writeFileSync(envFile, `RPC_URL=http://host.docker.internal:18545\nPRIVATE_KEY=${owner.privateKey}\nPOLL_INTERVAL_MS=100\nPREVIEW_TTL_SECONDS=600\nRPC_TIMEOUT_MS=120000\nDEPLOYMENT_BLOCK=${startBlock}\n`, { mode: 0o600 })
  console.log('SETUP launch Docker container')
  docker('volume', 'create', volumeName); volumeCreated = true
  docker('run', '-d', '--name', containerName, '--env-file', envFile, '-p', '127.0.0.1:18080:3000',
    '--mount', `type=volume,source=${volumeName},target=/app/data`, 'ore-vein-admin-server:local')
  containerCreated = true
  await waitReady()
  assert.equal(docker('exec', containerName, 'id', '-u'), '1000')
  socket = new WebSocket('ws://127.0.0.1:18080/v1/ws', { origin: 'http://localhost:5173' })
  socket.on('message', data => {
    const event = JSON.parse(String(data)) as { type: string; operation?: OperationView }
    if (event.operation) updates.push(event.operation)
  })
  console.log('SETUP check read endpoints')
  await api('/v1/config'); await api('/v1/balances'); await api('/v1/aave'); await api('/v1/fund')

  await order({ kind: 'contract.setURI', params: { uri: 'ipfs://fork-smoke' } })
  const successor = Wallet.createRandom().address
  const now = Math.max((await provider.getBlock('latest'))!.timestamp, Math.floor(Date.now() / 1000))
  await order({ kind: 'successor.schedule', params: { address: successor, timestamp: now + 86400 } })
  await order({ kind: 'successor.schedule', params: { address: successor, timestamp: now + 172800 } })
  const calendar = await api<{ successors: { address: string; timestamp: number }[] }>('/v1/successors')
  assert.equal(calendar.successors.find(value => value.address === successor)?.timestamp, now + 172800)
  await order({ kind: 'successor.remove', params: { address: successor } })
  assert.ok(!(await api<typeof calendar>('/v1/successors')).successors.some(value => value.address === successor))

  await order({ kind: 'lfj.swap', params: { tokenIn: 'WAVAX', tokenOut: 'USDC', amount: '5', slippageBps: 100 } })
  await order({ kind: 'lfj.swap', params: { tokenIn: 'WAVAX', tokenOut: 'USDT', amount: '2', slippageBps: 100 } })
  await order({ kind: 'aave.supply', params: { token: 'WAVAX', amount: '2' } })
  await order({ kind: 'aave.supply', params: { token: 'USDC', amount: '1' } })
  await order({ kind: 'aave.borrow', params: { token: 'USDC', amount: '0.1' } })
  await order({ kind: 'aave.repay', params: { token: 'USDC', amount: '0.2' } })
  await order({ kind: 'aave.withdraw', params: { token: 'USDC', amount: 'all' } })
  await order({ kind: 'aave.withdraw', params: { token: 'WAVAX', amount: 'all' } })

  const manager = new Contract(addresses.uniswapPositionManager, positionManagerAbi, provider)
  function minted(operation: OperationView): string {
    const logs = operation.steps.at(-1)!.receipt!.logs
    for (const log of logs) {
      if (log.address.toLowerCase() !== addresses.uniswapPositionManager.toLowerCase()) continue
      const event = manager.interface.parseLog(log)
      if (event?.name === 'Transfer' && event.args.from === ZeroAddress) return String(event.args.tokenId)
    }
    throw new Error('Mint event missing')
  }
  const tokenId = minted(await order({ kind: 'uniswap.mint', params: { tokenA: 'WAVAX', tokenB: 'USDC', amountA: '1', amountB: '1',
    fee: 500, range: 'full', slippageBps: 100 } }))
  await order({ kind: 'uniswap.increase', params: { tokenId, amount0: '0.01', amount1: '0.01', slippageBps: 100 } })
  await order({ kind: 'uniswap.collect', params: { tokenId } })
  await api('/v1/uniswap/positions')
  await order({ kind: 'uniswap.close', params: { tokenId, slippageBps: 100 } })
  await assert.rejects(manager.ownerOf(tokenId))

  const factory = new Contract(addresses.uniswapFactory, uniswapFactoryAbi, provider)
  let emptyFee: number | undefined
  for (const fee of [10000, 3000, 500, 100]) {
    if (await factory.getPool(tokens[1].address, tokens[2].address, fee) === ZeroAddress) { emptyFee = fee; break }
  }
  if (!emptyFee) {
    // Только в форке добавляем свободный fee tier, если живые пулы заняли все стандартные.
    const governance = new Contract(addresses.uniswapFactory, [
      'function owner() view returns(address)', 'function enableFeeAmount(uint24,int24)',
    ], provider)
    const factoryOwner: string = await governance.owner()
    await provider.send('hardhat_impersonateAccount', [factoryOwner])
    await provider.send('hardhat_setBalance', [factoryOwner, `0x${parseEther('100').toString(16)}`])
    emptyFee = 1234
    await (await governance.connect(new JsonRpcSigner(provider, factoryOwner)).getFunction('enableFeeAmount')(emptyFee, 10)).wait()
  }
  const freshPosition = minted(await order({ kind: 'uniswap.mint', params: { tokenA: 'USDT', tokenB: 'USDC', amountA: '0.2', amountB: '0.2',
    fee: emptyFee, range: 'full', initialPrice: '1', slippageBps: 100 } }))
  await order({ kind: 'uniswap.close', params: { tokenId: freshPosition, slippageBps: 100 } })
  await order({ kind: 'fund.changeDollar', params: { token: 'USDC' } })
  await order({ kind: 'fund.changeDollar', params: { token: 'USDT' } })

  // Полный жизненный цикл заявки: вкладчик создаётся только в локальном форке.
  const fund = new Contract(addresses.freeMine, freeMineAbi, provider)
  const investor = Wallet.createRandom().connect(provider)
  await provider.send('hardhat_setBalance', [investor.address, `0x${parseEther('100').toString(16)}`])
  const usdt = new Contract(tokens[1].address, [...erc20Abi, 'function transfer(address,uint256) returns(bool)'], investor)
  const transfer = usdt.interface.encodeFunctionData('transfer', [investor.address, 3000000n])
  await (await ore.connect(owner).getFunction('execute')(tokens[1].address, 0n, transfer)).wait()
  await (await usdt.approve(addresses.freeMine, 3000000n)).wait()
  await (await fund.connect(investor).getFunction('buy')(3000000n)).wait()
  const shiftId = String(await fund.currentShiftId())
  await (await fund.connect(investor).getFunction('openClaim')(parseEther('2'))).wait()
  const claimId = String((await fund.shifts(shiftId)).currentClaimId)
  assert.ok((await api<{ claims: unknown[] }>(`/v1/fund/shifts/${shiftId}/claims`)).claims.length > 0)
  await order({ kind: 'fund.closeShift', params: {} })
  const exitPrice = BigInt(await fund.entryPrice()) * 95n / 100n
  await order({ kind: 'fund.fundShift', params: { price: formatUnits(exitPrice, 18) } })

  // SIGKILL после отправки, до включения в блок; затем тот же volume.
  await provider.send('evm_setAutomine', [false])
  const recoveryPreview = await api<{ id: string }>('/v1/previews', {
    action: { kind: 'contract.setURI', params: { uri: 'ipfs://after-crash' } }, maxGasAvax: '1',
  })
  const recoveryInput = { previewId: recoveryPreview.id, requestId: randomUUID() }
  const recovery = await api<OperationView>('/v1/operations', recoveryInput)
  let hash: string | undefined
  for (let i = 0; i < 100; i++) {
    hash = (await api<OperationView>(`/v1/operations/${recovery.id}`)).steps[0].transactionHash
    if (hash) break
    await delay(100)
  }
  assert.ok(hash)
  socket.terminate(); socket = undefined
  docker('kill', '--signal', 'KILL', containerName)
  await provider.send('evm_setAutomine', [true])
  await provider.send('evm_mine', [])
  docker('start', containerName)
  await waitReady()
  const recovered = await waitOperation(recovery.id)
  assert.equal(recovered.steps[0].transactionHash, hash)
  assert.equal((await api<OperationView>('/v1/operations', recoveryInput)).id, recovery.id)
  assert.equal(await ore.contractURI(), 'ipfs://after-crash')
  console.log('PASS container SIGKILL recovery, persistent idempotency and unchanged transaction hash')

  // Перемотка времени выполняется после операций с DEX deadline.
  await provider.send('evm_increaseTime', [1209601])
  await provider.send('evm_mine', [])
  await order({ kind: 'fund.expireClaim', params: { shiftId, claimId } })
  const newPrice = BigInt(await fund.entryPrice()) * 101n / 100n
  await order({ kind: 'fund.updateEntryPrice', params: { price: formatUnits(newPrice, 18) } })
  assert.ok(updates.some(operation => operation.status === 'waiting'))
  assert.ok(updates.some(operation => operation.status === 'succeeded'))
  console.log(`PASS WebSocket progress (${updates.length} updates), owner checks, reads and all 17 operation kinds`)
  console.log('Docker fork smoke passed. No mainnet transactions were sent.')
} finally {
  socket?.terminate()
  if (containerCreated) docker('rm', '-f', containerName)
  if (volumeCreated) docker('volume', 'rm', volumeName)
  if (snapshot) {
    try { await provider.send('evm_revert', [snapshot]) } catch { console.error('Fork cleanup unavailable; restart the local Hardhat node.') }
  }
  provider.destroy()
  assert.ok(relative(cache, temporary).startsWith('fork-') && !relative(cache, temporary).startsWith('..'))
  rmSync(temporary, { recursive: true, force: true })
}
