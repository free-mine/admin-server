import Fastify from 'fastify'
import { z, ZodError } from 'zod'
import { WebSocket, WebSocketServer } from 'ws'

import { Access } from './access.js'
import type { Services } from './types.js'
import { previewView } from '../operations/index.js'
import { AppError, publicError } from '../shared/index.js'
import { readAave, listPositions } from '../protocols/index.js'
import { tokens, CHAIN_ID, addresses } from '../config/index.js'
import { readFund, readShift, readClaims } from '../fund/index.js'
import {
  idSchema,
  pageSchema,
  submitSchema,
  replacementSchema,
  previewRequestSchema,
} from '../requests/index.js'

export function createServer(services: Services) {
  const { config, chain, operations, previews, successors, journal } = services
  const access = new Access(config.allowedDomain, config.panelPin)
  // Не логируем тела запросов, заголовки и исключения ethers с RPC URL.
  const app = Fastify({
    logger: false,
    bodyLimit: 32768,
    requestTimeout: 30000,
    forceCloseConnections: true,
  })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!access.allows(request.headers)) {
      throw new AppError('DOMAIN_NOT_ALLOWED', 403)
    }
    if (request.headers.origin) {
      reply.header('Access-Control-Allow-Origin', request.headers.origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
      reply.header('Access-Control-Allow-Credentials', 'true')
    }
    if (request.method === 'OPTIONS') {
      return reply.status(204).send()
    }
    if (
      request.routeOptions.config.public !== true &&
      !access.session(request.headers.cookie)
    ) {
      throw new AppError('AUTH_REQUIRED', 401)
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          fields: error.issues.map(issue => issue.path.join('.')),
        },
      })
    }
    const httpStatus =
      error && typeof error === 'object' && 'statusCode' in error
        ? Number(error.statusCode)
        : 500
    const status =
      error instanceof AppError
        ? error.status
        : httpStatus >= 400 && httpStatus < 500
          ? httpStatus
          : 500
    return reply.status(status).send({ error: publicError(error) })
  })
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND' } }),
  )

  app.get('/health', { config: { public: true } }, async () => ({
    status: 'ok',
  }))
  app.get('/v1/session', { config: { public: true } }, async request => ({
    authenticated: !!access.session(request.headers.cookie),
  }))
  app.post(
    '/v1/session',
    { config: { public: true } },
    async (request, reply) => {
      const { pin } = z.object({ pin: z.string().max(32) }).parse(request.body)
      const session = access.login(pin, request.headers.cookie)
      closeUnauthorizedSockets()
      const secure =
        request.protocol === 'https' ||
        request.headers.origin?.startsWith('https://') === true
      reply.header('Set-Cookie', access.cookie(session, secure))
      return { authenticated: true }
    },
  )
  app.post(
    '/v1/session/logout',
    { config: { public: true } },
    async (request, reply) => {
      access.logout(request.headers.cookie)
      closeUnauthorizedSockets()
      const secure =
        request.protocol === 'https' ||
        request.headers.origin?.startsWith('https://') === true
      reply.header('Set-Cookie', access.cookie(undefined, secure))
      return { authenticated: false }
    },
  )
  app.get('/ready', async (_request, reply) => {
    if (operations.fatal) {
      return reply
        .status(503)
        .send({ status: 'unavailable', error: { code: 'JOURNAL_UNAVAILABLE' } })
    }
    try {
      if (chain.readOnly) {
        await chain.assertAvailable()
      } else {
        await chain.assertOwner()
      }
      return { status: 'ready', readOnly: chain.readOnly }
    } catch (error) {
      return reply
        .status(503)
        .send({ status: 'unavailable', error: publicError(error) })
    }
  })
  app.get('/v1/config', async () => ({
    chainId: CHAIN_ID,
    owner: chain.owner,
    readOnly: chain.readOnly,
    addresses,
    tokens,
    previewTtlSeconds: config.previewTtlSeconds,
    websocket: '/v1/ws',
    journal: '/v1/journal',
  }))
  app.get('/v1/journal', async () => journal.status)
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
    await chain.assertOwner()
    const existing = operations.existing(input.requestId, input.previewId)
    if (existing) {
      return reply.send(existing)
    }
    return reply
      .status(202)
      .send(operations.submit(previews.get(input.previewId), input.requestId))
  })
  app.get('/v1/operations', async request => {
    const { offset, limit } = pageSchema.parse(request.query)
    return {
      offset,
      limit,
      total: operations.count,
      operations: operations.list(offset, limit),
    }
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

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  })
  const alive = new WeakSet<WebSocket>()
  const socketSessions = new WeakMap<WebSocket, string>()
  const closeUnauthorizedSockets = () => {
    for (const socket of sockets.clients) {
      if (!access.get(socketSessions.get(socket) ?? '')) {
        socket.close(1008, 'AUTH_REQUIRED')
      }
    }
  }
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }
    if (!access.get(socketSessions.get(socket) ?? '')) {
      socket.close(1008, 'AUTH_REQUIRED')
      return
    }
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, 'SLOW_CLIENT')
      return
    }
    socket.send(JSON.stringify(value))
  }
  app.server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/ws' || !access.allows(request.headers)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const session = access.session(request.headers.cookie)
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, connection => {
      socketSessions.set(connection, session.token)
      const expires = setTimeout(
        () => connection.close(1008, 'AUTH_REQUIRED'),
        Math.max(0, session.expiresAt - Date.now()),
      )
      expires.unref()
      connection.once('close', () => clearTimeout(expires))
      sockets.emit('connection', connection)
    })
  })
  sockets.on('connection', socket => {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
    socket.on('error', () => socket.terminate())
    // Снимок при каждом подключении позволяет пережить потерю любых событий.
    send(socket, {
      type: 'operations.snapshot',
      operations: operations.list(0, 100),
    })
    socket.on('message', () => socket.close(1008, 'READ_ONLY_CHANNEL'))
  })
  const unsubscribe = operations.subscribe(operation => {
    for (const socket of sockets.clients) {
      send(socket, { type: 'operation.updated', operation })
    }
  })
  const heartbeat = setInterval(() => {
    closeUnauthorizedSockets()
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) {
        socket.terminate()
        continue
      }
      alive.delete(socket)
      socket.ping()
    }
  }, 30000)
  heartbeat.unref()
  app.addHook('preClose', async () => {
    clearInterval(heartbeat)
    unsubscribe()
    for (const socket of sockets.clients) {
      socket.terminate()
    }
    sockets.close()
  })
  return app
}
