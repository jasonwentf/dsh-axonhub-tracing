import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { install } from '../src/host.js'

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-host-'))

class Headers {
  constructor() {
    this.map = new Map()
  }

  set(name, value) {
    this.map.set(name, value)
  }

  get(name) {
    return this.map.get(name)
  }

  has(name) {
    return this.map.has(name)
  }
}

function harness(config = {}, sessions = []) {
  const listeners = []
  const provided = new Map()
  const byId = new Map(sessions.map((item) => [item.id, item]))
  // Each harness gets its own DSH_HOME so a settings write in one test cannot
  // leak into the next one through the shared settings file.
  process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'axonhub-tracing-host-'))
  const ctx = {
    on(name, listener) {
      listeners.push([name, listener])
      return () => {}
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => byId.get(id) }
      if (name === 'llm')
        return {
          listProviders: () => [
            { id: 'axonhubchatcompletion', name: 'AxonHub' },
            { id: 'opencode-go', name: 'OpenCode Go' },
          ],
        }
      return undefined
    },
    provide(name, value) {
      provided.set(name, value)
    },
    logger: { info() {}, warn() {} },
    fiber: {},
  }
  install(ctx, config)
  const stamp = (request) => {
    const headers = new Headers()
    let called = false
    for (const [name, listener] of listeners) {
      if (name !== 'llm-pi-ai/request-headers') continue
      listener(request, headers, () => {
        called = true
        return headers
      })
    }
    assert.equal(called, true, 'the listener must always call next()')
    return headers
  }
  return { ctx, stamp, provided }
}

const session = {
  id: 's1',
  header: { id: 's1', version: 4 },
  log: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
  ],
}

test('a matching provider receives all three headers', () => {
  const { stamp } = harness({}, [session])
  const headers = stamp({
    provider: 'axonhubchatcompletion',
    model: 'deepseek-v4.1-flash',
    baseURL: 'http://gateway.test/v1',
    sessionId: 's1',
  })
  assert.equal(headers.get('AH-Thread-Id'), 's1')
  assert.equal(headers.get('AH-Trace-Id'), 's1:t2')
  assert.equal(headers.get('AH-Kind'), 'user')
})

test('a non-matching provider is left untouched', () => {
  const { stamp } = harness({}, [session])
  const headers = stamp({
    provider: 'opencode-go',
    model: 'm',
    baseURL: 'https://api.example.test',
    sessionId: 's1',
  })
  assert.equal(headers.has('AH-Thread-Id'), false)
  assert.equal(headers.has('AH-Trace-Id'), false)
})

test('the master switch stops every header', () => {
  const { stamp } = harness({ enabled: false }, [session])
  const headers = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' })
  assert.equal(headers.has('AH-Trace-Id'), false)
})

test('an empty kind header removes the third header', () => {
  const { stamp } = harness({ kindHeader: '' }, [session])
  const headers = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' })
  assert.equal(headers.has('AH-Thread-Id'), true)
  assert.equal(headers.has('AH-Kind'), false)
})

test('the optional session header is off by default and can be enabled', () => {
  const off = harness({}, [session])
  assert.equal(off.stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' }).has('X-Session-Id'), false)
  const on = harness({ emitSessionHeader: true }, [session])
  assert.equal(on.stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' }).get('X-Session-Id'), 's1')
})

test('internal purposes are stamped with their own branch', () => {
  const { stamp } = harness({}, [session])
  const title = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1', purpose: 'session-title' })
  assert.equal(title.get('AH-Trace-Id'), 's1:title')
  assert.equal(title.get('AH-Thread-Id'), 's1#title')
  assert.equal(title.get('AH-Kind'), 'title')

  const review = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1', purpose: 'auto-review' })
  assert.equal(review.get('AH-Trace-Id'), 's1:review')
  assert.equal(review.get('AH-Thread-Id'), 's1#review')
  assert.equal(review.get('AH-Kind'), 'approval')

  const compaction = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1', purpose: 'compaction' })
  assert.equal(compaction.get('AH-Trace-Id'), 's1:t2')
  assert.equal(compaction.get('AH-Thread-Id'), 's1')
  assert.equal(compaction.get('AH-Kind'), 'compaction')
})

test('a request without a session still calls next() and adds nothing', () => {
  const { stamp } = harness({}, [session])
  const headers = stamp({ provider: 'axonhubchatcompletion', model: 'm' })
  assert.equal(headers.has('AH-Trace-Id'), false)
})

test('a throwing session lookup never breaks the request', () => {
  const listeners = []
  const ctx = {
    on(name, listener) {
      listeners.push(listener)
    },
    get(name) {
      if (name === 'sessions') {
        return {
          get() {
            throw new Error('boom')
          },
        }
      }
      return undefined
    },
    provide() {},
    logger: { info() {}, warn() {} },
  }
  install(ctx, {})
  const headers = new Headers()
  let called = false
  listeners[0]({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' }, headers, () => {
    called = true
    return headers
  })
  assert.equal(called, true)
})

test('getState reports providers and the recent list', async () => {
  const { stamp, provided } = harness({}, [session])
  stamp({ provider: 'axonhubchatcompletion', model: 'm', baseURL: 'http://gateway.test/v1', sessionId: 's1' })
  const remote = provided.get('axonhubTracing')
  assert.ok(remote)
  const state = await remote.getState()
  assert.equal(state.providers.length, 2)
  const own = state.providers.find((provider) => provider.id === 'axonhubchatcompletion')
  assert.equal(own.baseURL, 'http://gateway.test')
  assert.equal(own.auto, true)
  assert.equal(state.recent.length, 1)
  assert.equal(state.recent[0].kind, 'user')
  assert.equal(state.settings.enabled, true)
})

test('recent entries are capped by recentLimit', async () => {
  const { stamp, provided } = harness({ recentLimit: 2 }, [session])
  for (let index = 0; index < 5; index += 1) {
    stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' })
  }
  const state = await provided.get('axonhubTracing').getState()
  assert.equal(state.recent.length, 2)
})

test('updateSettings merges and is visible to the next request', async () => {
  const { stamp, provided } = harness({}, [session])
  const remote = provided.get('axonhubTracing')
  await remote.updateSettings({ mode: 'all', titleThread: 'shared' })
  assert.equal((await remote.getState()).settings.mode, 'all')

  const headers = stamp({
    provider: 'anthropic',
    model: 'm',
    sessionId: 's1',
    purpose: 'session-title',
  })
  assert.equal(headers.get('AH-Trace-Id'), 's1:title')
  assert.equal(headers.get('AH-Thread-Id'), 's1')
})

test('updateSettings rejects unknown values by falling back', async () => {
  const { provided } = harness({}, [session])
  const remote = provided.get('axonhubTracing')
  await remote.updateSettings({ mode: 'nonsense', traceHeader: 'bad header' })
  const settings = (await remote.getState()).settings
  assert.equal(settings.mode, 'auto')
  assert.equal(settings.traceHeader, 'AH-Trace-Id')
})

test('hashIds also hides the optional session header', () => {
  const { stamp } = harness({ emitSessionHeader: true, hashIds: true }, [session])
  const headers = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 's1' })
  assert.match(headers.get('X-Session-Id'), /^[0-9a-f]{16}$/u)
  assert.notEqual(headers.get('X-Session-Id'), 's1')
})

test('a value HTTP cannot carry leaves no headers behind', () => {
  const { stamp } = harness({}, [session])
  const headers = stamp({ provider: 'axonhubchatcompletion', model: 'm', sessionId: 'bad\nid' })
  assert.equal(headers.has('AH-Thread-Id'), false)
  assert.equal(headers.has('AH-Trace-Id'), false)
  assert.equal(headers.has('AH-Kind'), false)
})

test('updateSettings reports whether the file was written', async () => {
  const { provided } = harness({})
  const result = await provided.get('axonhubTracing').updateSettings({ mode: 'all' })
  assert.equal(result.persisted, true)
  assert.equal(result.settings.mode, 'all')
})

test('per provider override changes exactly one key and can be removed', async () => {
  const { provided } = harness({}, [session])
  const remote = provided.get('axonhubTracing')
  await remote.setProvider('opencode-go', true)
  let state = await remote.getState()
  assert.equal(state.settings.overrides['opencode-go'], true)

  await remote.setProvider('opencode-go', null)
  state = await remote.getState()
  assert.equal(Object.prototype.hasOwnProperty.call(state.settings.overrides, 'opencode-go'), false)
})

test('a disabled provider never exposes its endpoint', async () => {
  const { stamp, provided } = harness({}, [session])
  stamp({
    provider: 'opencode-go',
    model: 'm',
    baseURL: 'https://user:secret@api.example.test/v1',
    sessionId: 's1',
  })
  const state = await provided.get('axonhubTracing').getState()
  const other = state.providers.find((provider) => provider.id === 'opencode-go')
  assert.equal(other.baseURL, null)
})

test('a tagged provider keeps only the origin of its endpoint', async () => {
  const { stamp, provided } = harness({}, [session])
  stamp({
    provider: 'axonhubchatcompletion',
    model: 'm',
    baseURL: 'https://user:secret@gateway.test/v1?token=abc',
    sessionId: 's1',
  })
  const state = await provided.get('axonhubTracing').getState()
  const own = state.providers.find((provider) => provider.id === 'axonhubchatcompletion')
  assert.equal(own.baseURL, 'https://gateway.test')
})
