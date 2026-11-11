import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SettingsStore, settingsFile } from '../src/store.js'

function store(initial = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-store-'))
  return new SettingsStore(path.join(dir, 'settings.json'), initial)
}

test('a fresh store starts from the entry config and the defaults', () => {
  const item = store({ mode: 'all' })
  assert.equal(item.get().mode, 'all')
  assert.equal(item.get().traceHeader, 'AH-Trace-Id')
})

test('an update is written to disk and reloaded by a new store', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-store-')), 'settings.json')
  const first = new SettingsStore(file, {})
  first.update({ enabled: false, overrides: { anthropic: true } })

  const second = new SettingsStore(file, {})
  second.load()
  assert.equal(second.get().enabled, false)
  assert.deepEqual(second.get().overrides, { anthropic: true })

  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.enabled, false)
})

test('an unreadable file falls back without throwing', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-store-')), 'settings.json')
  const first = new SettingsStore(file, {})
  first.update({ mode: 'none' })
  const warnings = []
  const second = new SettingsStore(file, { mode: 'none' })
  second.logger = { warn: (message) => warnings.push(message) }
  // Corrupt the file behind the store's back.
  writeFileSync(file, '{not json')
  second.load()
  assert.equal(second.get().mode, 'none', 'the constructor defaults survive a broken file')
  assert.equal(second.get().enabled, false, 'a broken file keeps tracing off instead of defaulting back on')
  assert.equal(warnings.length, 1, 'the failure is logged once')
})

test('recent entries are newest first and trimmed', () => {
  const item = store({ recentLimit: 3 })
  for (let index = 1; index <= 5; index += 1) item.record({ at: index, kind: 'user' })
  const recent = item.recent()
  assert.equal(recent.length, 3)
  assert.equal(recent[0].at, 5)
  assert.equal(recent[2].at, 3)
})

test('the settings file lives under DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/example-dsh-home'
  try {
    assert.equal(settingsFile(), '/tmp/example-dsh-home/axonhub-tracing/settings.json')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a failed save is reported instead of pretending success', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-store-'))
  const blocker = path.join(dir, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const item = new SettingsStore(path.join(blocker, 'settings.json'), {})
  assert.equal(item.save(), false)
  assert.equal(item.saved, false)
  assert.equal(item.get().mode, 'auto')
})

test('a concurrent writer is not clobbered by a stale memory copy', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-store-')), 'settings.json')
  const first = new SettingsStore(file, {})
  first.update({ mode: 'all' })

  const second = new SettingsStore(file, {})
  second.load()
  second.update({ subagentThread: 'parent' })

  first.update({ approvalThread: 'shared' })

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.mode, 'all')
  assert.equal(onDisk.subagentThread, 'parent')
  assert.equal(onDisk.approvalThread, 'shared')
})
