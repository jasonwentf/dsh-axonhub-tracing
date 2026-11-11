import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldTag, autoMatches } from '../src/policy.js'
import { DEFAULTS, normalizeSettings } from '../src/config.js'

const base = normalizeSettings(DEFAULTS)

test('auto matches a provider id containing axon', () => {
  assert.equal(shouldTag(base, 'axonhubchatcompletion', 'http://10.0.0.5:8090/v1'), true)
  assert.equal(autoMatches('axonhubchatcompletion', ''), true)
})

test('auto matches a base URL containing axon', () => {
  assert.equal(shouldTag(base, 'relay', 'https://axon.example.test/v1'), true)
})

test('auto ignores unrelated providers', () => {
  assert.equal(shouldTag(base, 'opencode-go', 'https://api.example.test'), false)
  assert.equal(shouldTag(base, 'anthropic', 'http://127.0.0.1:8765/v1'), false)
})

test('all tags every provider', () => {
  const settings = normalizeSettings({ mode: 'all' })
  assert.equal(shouldTag(settings, 'anthropic', 'http://127.0.0.1:8765/v1'), true)
  assert.equal(shouldTag(settings, 'opencode-go', ''), true)
})

test('none tags nothing by default', () => {
  const settings = normalizeSettings({ mode: 'none' })
  assert.equal(shouldTag(settings, 'axonhubchatcompletion', ''), false)
})

test('an override adds a provider that auto would skip', () => {
  const settings = normalizeSettings({ overrides: { anthropic: true } })
  assert.equal(shouldTag(settings, 'anthropic', 'http://127.0.0.1:8765/v1'), true)
})

test('an override removes a provider that auto would tag', () => {
  const settings = normalizeSettings({ overrides: { axonhubchatcompletion: false } })
  assert.equal(shouldTag(settings, 'axonhubchatcompletion', ''), false)
})

test('override keys are matched without case sensitivity', () => {
  const settings = normalizeSettings({ overrides: { AxonHub: true } })
  assert.equal(shouldTag(settings, 'axonhub', ''), true)
})

test('the master switch wins over every mode', () => {
  const settings = normalizeSettings({ enabled: false, mode: 'all', overrides: { anthropic: true } })
  assert.equal(shouldTag(settings, 'anthropic', ''), false)
})
