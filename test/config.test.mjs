import test from 'node:test'
import assert from 'node:assert/strict'
import { assertHeaderName, normalizeSettings } from '../src/config.js'

test('defaults are stable', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.enabled, true)
  assert.equal(settings.mode, 'auto')
  assert.deepEqual(settings.overrides, {})
  assert.equal(settings.threadHeader, 'AH-Thread-Id')
  assert.equal(settings.traceHeader, 'AH-Trace-Id')
  assert.equal(settings.kindHeader, 'AH-Kind')
  assert.equal(settings.turnTracking, true)
  assert.equal(settings.subagentThread, 'own')
  assert.equal(settings.titleThread, 'own')
  assert.equal(settings.approvalThread, 'own')
  assert.equal(settings.recentLimit, 20)
})

test('the old shared switches migrate onto the split settings', () => {
  const settings = normalizeSettings({ internalThread: 'shared', traceGranularity: 'session' })
  assert.equal(settings.turnTracking, false)
  assert.equal(settings.titleThread, 'shared')
  assert.equal(settings.approvalThread, 'shared')

  const fresh = normalizeSettings({})
  assert.equal(fresh.turnTracking, true)
  assert.equal(fresh.titleThread, 'own')
})

test('an invalid header name falls back to the default', () => {
  const settings = normalizeSettings({ traceHeader: 'bad header\n' })
  assert.equal(settings.traceHeader, 'AH-Trace-Id')
})

test('an empty kind header turns the third header off', () => {
  const settings = normalizeSettings({ kindHeader: '' })
  assert.equal(settings.kindHeader, '')
})

test('unknown enum values fall back', () => {
  const settings = normalizeSettings({ mode: 'sometimes', subagentThread: 'both', titleThread: 'both' })
  assert.equal(settings.mode, 'auto')
  assert.equal(settings.subagentThread, 'own')
  assert.equal(settings.titleThread, 'own')
})

test('overrides keep only boolean values', () => {
  const settings = normalizeSettings({ overrides: { a: true, b: false, c: 'yes', '': true } })
  assert.deepEqual(settings.overrides, { a: true, b: false })
})

test('recent limit is clamped', () => {
  assert.equal(normalizeSettings({ recentLimit: 0 }).recentLimit, 1)
  assert.equal(normalizeSettings({ recentLimit: 900 }).recentLimit, 50)
  assert.equal(normalizeSettings({ recentLimit: 12.9 }).recentLimit, 12)
})

test('header name validator accepts standard tokens', () => {
  assert.equal(assertHeaderName('AH-Trace-Id'), true)
  assert.equal(assertHeaderName('x-dsh_test.header'), true)
  assert.equal(assertHeaderName('bad header'), false)
  assert.equal(assertHeaderName('名字'), false)
})

test('transport owned header names fall back to the defaults', () => {
  const settings = normalizeSettings({
    threadHeader: 'Content-Length',
    traceHeader: 'user-agent',
    kindHeader: 'authorization',
  })
  assert.equal(settings.threadHeader, 'AH-Thread-Id')
  assert.equal(settings.traceHeader, 'AH-Trace-Id')
  assert.equal(settings.kindHeader, 'AH-Kind')

  const auth = normalizeSettings({ traceHeader: 'x-api-key' })
  assert.equal(auth.traceHeader, 'AH-Trace-Id')
})

test('duplicate header names reset the pair and drop the third', () => {
  const settings = normalizeSettings({
    threadHeader: 'X-Trace',
    traceHeader: 'x-trace',
    kindHeader: 'AH-Kind',
  })
  assert.equal(settings.threadHeader, 'AH-Thread-Id')
  assert.equal(settings.traceHeader, 'AH-Trace-Id')
  assert.equal(settings.kindHeader, 'AH-Kind')

  const third = normalizeSettings({ threadHeader: 'AH-Kind' })
  assert.equal(third.threadHeader, 'AH-Kind')
  assert.equal(third.kindHeader, '')
})
