import test from 'node:test'
import assert from 'node:assert/strict'

import { readConfig } from '../src/config/index.js'

const env = {
  RPC_URL: 'https://rpc.example',
  ALLOWED_DOMAIN: 'admin.example',
  PANEL_PIN: '001234',
}

test('log block ranges default to 10 and stay within the RPC provider limit', () => {
  assert.equal(readConfig(env).logBlockRange, 10)
  for (const range of ['1', '10']) {
    assert.equal(
      readConfig({ ...env, LOG_BLOCK_RANGE: range }).logBlockRange,
      Number(range),
    )
  }
  for (const range of ['0', '11', '1.5']) {
    assert.throws(() => readConfig({ ...env, LOG_BLOCK_RANGE: range }), {
      code: 'INVALID_ENV_LOG_BLOCK_RANGE',
    })
  }
})

test('exactly one hostname is required and DNS names are normalized', () => {
  for (const domain of ['localhost', 'ADMIN.Example', 'panel-1.example']) {
    assert.equal(
      readConfig({ ...env, ALLOWED_DOMAIN: domain }).allowedDomain,
      domain.toLowerCase(),
    )
  }
  for (const domain of [
    undefined,
    '',
    '*',
    '*.example',
    'https://admin.example',
    'admin.example:5175',
    'admin.example/path',
    'admin.example?query',
    'admin.example#fragment',
    'user@admin.example',
    'admin.example,other.example',
    'admin.example other.example',
    '.admin.example',
    'admin.example.',
    'admin..example',
    '-admin.example',
    'admin-.example',
    'admin_panel.example',
    `${'a'.repeat(64)}.example`,
    Array(5).fill('a'.repeat(63)).join('.'),
  ]) {
    assert.throws(() => readConfig({ ...env, ALLOWED_DOMAIN: domain }), {
      code: 'INVALID_ENV_ALLOWED_DOMAIN',
    })
  }
})

test('PIN must be configured as 4 to 32 digits, preserving leading zeros', () => {
  for (const pin of ['0000', '001234', '1'.repeat(32)]) {
    assert.equal(readConfig({ ...env, PANEL_PIN: pin }).panelPin, pin)
  }
  for (const pin of [
    undefined,
    '',
    '123',
    '1'.repeat(33),
    '1e10',
    '12 34',
    'abcd',
  ]) {
    assert.throws(() => readConfig({ ...env, PANEL_PIN: pin }), {
      code: 'INVALID_ENV_PANEL_PIN',
    })
  }
})
