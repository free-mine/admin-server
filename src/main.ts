import { Chain } from './chain/index.js'
import { readConfig } from './config/index.js'
import { createServer } from './http/index.js'
import { publicError } from './shared/index.js'
import { Successors } from './successors/index.js'
import { PublicState } from './public-state/index.js'
import { PublicServer } from './public-server/index.js'
import { Journal, Previews, Operations } from './operations/index.js'

const port = 3000
let chain: Chain | undefined
let journal: Journal | undefined
let publicState: PublicState | undefined
try {
  const config = readConfig()
  chain = await Chain.connect(config)
  const remote = new PublicServer({
    url: config.publicServerUrl,
    key: config.publicServerKey,
    timeoutMs: config.publicServerTimeoutMs,
  })
  journal = new Journal('/app/data', chain.owner, chain.readOnly, remote)
  await journal.sync()
  const operations = new Operations(journal, chain, config.pollMs)
  const state = new PublicState(remote)
  publicState = state
  const unsubscribe = operations.subscribe(operation => {
    for (const step of operation.steps) {
      if (step.receipt) {
        state.requireBlock(step.receipt.blockNumber)
      }
    }
  })
  const observeRecovered = () => {
    for (const operation of journal?.all() ?? []) {
      for (const step of operation.steps) {
        if (step.receipt) {
          state.requireBlock(step.receipt.blockNumber)
        }
      }
    }
  }
  const unsubscribeJournal = journal.subscribe(observeRecovered)
  observeRecovered()
  const previews = new Previews(chain, config.previewTtlSeconds)
  const successors = new Successors(chain, config)
  const app = createServer({
    config,
    chain,
    operations,
    previews,
    successors,
    journal,
    publicState: state,
  })
  await app.listen({ host: config.host, port })
  journal.start(config.syncIntervalMs)
  state.start(config.syncIntervalMs)
  operations.start()
  console.log(
    JSON.stringify({
      code: 'SERVER_READY',
      port,
      owner: chain.owner,
      readOnly: chain.readOnly,
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
    unsubscribe()
    unsubscribeJournal()
    await state.stop()
    await journal?.stop()
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
  await publicState?.stop()
  await journal?.stop()
  chain?.dispose()
  process.exitCode = 1
}
