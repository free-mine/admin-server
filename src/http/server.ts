import Fastify from 'fastify'
import { WebSocket, WebSocketServer } from 'ws'
import { ZodError, z } from 'zod'
import { addresses, CHAIN_ID, tokens } from '../config/index.js'
import { readClaims, readFund, readShift } from '../fund/index.js'
import { listPositions, readAave } from '../protocols/index.js'
import { previewView } from '../operations/index.js'
import { idSchema, pageSchema, previewRequestSchema, replacementSchema, submitSchema } from '../requests/index.js'
import { AppError, publicError } from '../shared/index.js'
import type { Services } from './types.js'

export function createServer(services: Services) {
  const { config, chain, operations, previews, successors } = services
  // Не логируем тела запросов, заголовки и исключения ethers с RPC URL.
  const app = Fastify({ logger: false, bodyLimit: 32768, requestTimeout: 30000, forceCloseConnections: true })
  const origins = new Set(config.allowedOrigins)
  const allowedOrigin = (origin?: string) => origin === undefined || origins.has(origin)

  app.addHook('onRequest', async (request, reply) => {
    if (!allowedOrigin(request.headers.origin)) throw new AppError('ORIGIN_NOT_ALLOWED', 403)
    if (request.headers.origin) {
      reply.header('Access-Control-Allow-Origin', request.headers.origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
    }
    reply.header('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') return reply.status(204).send()
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', fields: error.issues.map(issue => issue.path.join('.')) } })
    }
    const httpStatus = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
    const status = error instanceof AppError ? error.status : httpStatus >= 400 && httpStatus < 500 ? httpStatus : 500
    return reply.status(status).send({ error: publicError(error) })
  })
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND' } }))

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async (_request, reply) => {
    if (operations.fatal) return reply.status(503).send({ status: 'unavailable', error: { code: 'JOURNAL_UNAVAILABLE' } })
    try { await chain.assertOwner(); return { status: 'ready' } }
    catch (error) { return reply.status(503).send({ status: 'unavailable', error: publicError(error) }) }
  })
  app.get('/v1/config', async () => ({ chainId: CHAIN_ID, owner: chain.owner, addresses, tokens,
    previewTtlSeconds: config.previewTtlSeconds, websocket: '/v1/ws' }))
  app.get('/v1/balances', async () => chain.balances())
  app.get('/v1/successors', async () => successors.read())
  app.get('/v1/fund', async () => readFund(chain))
  app.get('/v1/fund/shifts/:id', async request => {
    const { id } = z.object({ id: idSchema }).parse(request.params)
    return readShift(chain, id)
  })
  app.get('/v1/fund/shifts/:id/claims', async request => {
    const { id } = z.object({ id: idSchema }).parse(request.params)
    const { offset, limit } = pageSchema.parse(request.query)
    return readClaims(chain, id, offset, limit)
  })
  app.get('/v1/aave', async () => readAave(chain))
  app.get('/v1/uniswap/positions', async request => {
    const { offset, limit } = pageSchema.parse(request.query)
    return listPositions(chain, offset, limit)
  })
  app.post('/v1/previews', async (request, reply) => {
    const input = previewRequestSchema.parse(request.body)
    const preview = await previews.create(input)
    return reply.status(201).send(previewView(preview))
  })
  app.post('/v1/operations', async (request, reply) => {
    const input = submitSchema.parse(request.body)
    const existing = operations.existing(input.requestId, input.previewId)
    if (existing) return reply.send(existing)
    return reply.status(202).send(operations.submit(previews.get(input.previewId), input.requestId))
  })
  app.get('/v1/operations', async request => {
    const { offset, limit } = pageSchema.parse(request.query)
    return { offset, limit, total: operations.journal.all().length, operations: operations.list(offset, limit) }
  })
  app.get('/v1/operations/:id', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    return operations.get(id)
  })
  app.post('/v1/operations/:id/resolve', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const { transactionHash } = replacementSchema.parse(request.body)
    return operations.resolve(id, transactionHash)
  })

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })
  const alive = new WeakSet<WebSocket>()
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'SLOW_CLIENT'); return }
    socket.send(JSON.stringify(value))
  }
  app.server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/ws' || !allowedOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return
    }
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection))
  })
  sockets.on('connection', socket => {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
    socket.on('error', () => socket.terminate())
    // Снимок при каждом подключении позволяет пережить потерю любых событий.
    send(socket, { type: 'operations.snapshot', operations: operations.list(0, 100) })
    socket.on('message', () => socket.close(1008, 'READ_ONLY_CHANNEL'))
  })
  const unsubscribe = operations.subscribe(operation => {
    for (const socket of sockets.clients) send(socket, { type: 'operation.updated', operation })
  })
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue }
      alive.delete(socket); socket.ping()
    }
  }, 30000)
  heartbeat.unref()
  app.addHook('preClose', async () => {
    clearInterval(heartbeat); unsubscribe()
    for (const socket of sockets.clients) socket.terminate()
    sockets.close()
  })
  return app
}
