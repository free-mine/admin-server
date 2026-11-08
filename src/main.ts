import { Chain } from './chain/index.js'
import { readConfig } from './config/index.js'
import { createServer } from './http/index.js'
import { publicError } from './shared/index.js'
import { Successors } from './successors/index.js'
import { Journal, Previews, Operations } from './operations/index.js'

let chain: Chain | undefined
try {
  const config = readConfig()
  chain = new Chain(config)
  await chain.assertOwner()
  const operations = new Operations(
    new Journal(config.dataDir, chain.owner),
    chain,
    config.pollMs,
  )
  const previews = new Previews(chain, config.previewTtlSeconds)
  const successors = new Successors(chain, config)
  const app = createServer({ config, chain, operations, previews, successors })
  await app.listen({ host: config.host, port: config.port })
  operations.start()
  console.log(
    JSON.stringify({
      code: 'SERVER_READY',
      port: config.port,
      owner: chain.owner,
    }),
  )
  let stopping = false
  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    console.log(JSON.stringify({ code: 'SERVER_STOPPING' }))
    await operations.stop()
    await app.close()
    chain?.dispose()
  }
  process.once('SIGTERM', () => {
    void stop()
  })
  process.once('SIGINT', () => {
    void stop()
  })
} catch (error) {
  console.error(
    JSON.stringify({ code: 'STARTUP_FAILED', error: publicError(error) }),
  )
  chain?.dispose()
  process.exitCode = 1
}
