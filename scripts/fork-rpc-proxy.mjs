// Необязательный read-only прокси для форка: ограничивает частоту запросов
// Hardhat к публичному RPC и повторяет чтение после HTTP 429.
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const fallback = 'https://api.avax.network/ext/bc/C/rpc'
const upstream = process.env.FORK_UPSTREAM_URL || fallback
const allowed = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call', 'eth_feeHistory'])
const cache = new Map()
let active = 0, completed = 0
const recent = []
const waiting = []
async function schedule(body) {
  if (active >= 3) await new Promise(resolve => waiting.push(resolve))
  active++
  try { return await forward(body) }
  finally { active--; completed++; waiting.shift()?.() }
}
async function forward(body) {
  recent.push({ method: body.method, params: body.params }); if (recent.length > 12) recent.shift()
  if (!allowed.has(body.method)) throw new Error('METHOD_NOT_ALLOWED')
  const cacheable = !JSON.stringify(body.params ?? []).match(/latest|pending/) && body.method !== 'eth_blockNumber'
  const key = JSON.stringify([body.method, body.params])
  if (cacheable && cache.has(key)) return { ...cache.get(key), id: body.id }
  for (let attempt = 0; attempt < 8; attempt++) {
    await delay(100)
    const send = (url, timeout) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
    // Некоторые архивные RPC не отвечают на чтение нулевого адреса.
    const primary = body.params?.[0] === '0x0000000000000000000000000000000000000000' ? fallback : upstream
    let response
    try { response = await send(primary, 5000) }
    catch (error) { if (primary === fallback) throw error; response = await send(fallback, 15000) }
    if (response.status === 429) { await delay(Math.min(10000, 1000 * 2 ** attempt)); continue }
    if (!response.ok) throw new Error(`UPSTREAM_${response.status}`)
    const data = await response.json()
    if (cacheable && !data.error && data.result !== null && cache.size < 100000) cache.set(key, data)
    return data
  }
  throw new Error('UPSTREAM_RATE_LIMIT')
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/metrics') {
    response.end(JSON.stringify({ active, waiting: waiting.length, completed, cached: cache.size, recent })); return
  }
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const result = Array.isArray(body) ? await Promise.all(body.map(schedule)) : await schedule(body)
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error) }))
  }
})
server.listen(18546, '127.0.0.1', () => console.log('Read-only fork RPC proxy: http://127.0.0.1:18546'))
