import test from 'node:test'
import assert from 'node:assert/strict'

import { readConfig } from '../src/config/index.js'

test('log block ranges default to 10 and stay within the RPC provider limit', () => {
  const env = {
    RPC_URL: 'https://rpc.example',
    PUBLIC_SERVER_URL: 'https://public.example',
  }
  assert.equal(readConfig(env).logBlockRange, 10)
  for (const range of ['1', '10']) {
    assert.equal(
      readConfig({ ...env, LOG_BLOCK_RANGE: range }).logBlockRange,
      Number(range),
    )
  }
  for (const range of ['0', '11', '2000', '1.5']) {
    assert.throws(() => readConfig({ ...env, LOG_BLOCK_RANGE: range }), {
      code: 'INVALID_ENV_LOG_BLOCK_RANGE',
    })
  }
})

test('public server configuration supports offline startup and keeps credentials separate', () => {
  const config = readConfig({
    RPC_URL: 'https://rpc.example',
    PUBLIC_SERVER_URL: 'https://public.example/api/',
    PUBLIC_SERVER_KEY: ' owner-api-key ',
  })
  assert.equal(config.publicServerUrl, 'https://public.example/api/')
  assert.equal(config.publicServerKey, 'owner-api-key')
  assert.equal(config.privateKey, undefined)
  assert.equal(config.publicServerTimeoutMs, 5000)
  assert.equal(config.syncIntervalMs, 15000)
})

test('public server URL is explicit and cannot contain credentials or query secrets', () => {
  for (const url of [
    undefined,
    'invalid',
    'ftp://server.example',
    'https://key@server.example',
    'https://server.example?key=secret',
    'https://server.example/#fragment',
  ]) {
    assert.throws(
      () =>
        readConfig({ RPC_URL: 'https://rpc.example', PUBLIC_SERVER_URL: url }),
      { code: 'INVALID_ENV_PUBLIC_SERVER_URL' },
    )
  }
})
