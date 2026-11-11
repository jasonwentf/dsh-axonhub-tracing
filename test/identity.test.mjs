import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveIdentity, hashValue, lastTurn, rootOf, subagentOf } from '../src/identity.js'
import { normalizeSettings } from '../src/config.js'

const tag = (id) => hashValue(id).slice(0, 8)

function session(id, extra = {}) {
  return { id, header: { id, ...(extra.header ?? {}) }, log: extra.log ?? [] }
}

function world(sessions) {
  const map = new Map(sessions.map((item) => [item.id, item]))
  return (id) => map.get(id)
}

function settings(overrides = {}) {
  return normalizeSettings(overrides)
}

test('a user turn uses the session as thread and the turn as trace', () => {
  const getSession = world([session('s1', { log: [{ type: 'turn/start', data: { turn: 3 } }] })])
  const identity = deriveIdentity({ sessionId: 's1', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'user', thread: 's1', trace: 's1:t3' })
})

test('a compaction stays on the same trace as the running turn', () => {
  const getSession = world([session('s1', { log: [{ type: 'turn/start', data: { turn: 4 } }] })])
  const identity = deriveIdentity({ sessionId: 's1', purpose: 'compaction', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'compaction', thread: 's1', trace: 's1:t4' })
})

test('a title request gets its own thread and trace', () => {
  const getSession = world([session('s1')])
  const identity = deriveIdentity({ sessionId: 's1', purpose: 'session-title', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'title', thread: 's1#title', trace: 's1:title' })
})

test('an auto review gets its own thread and trace', () => {
  const getSession = world([session('s1')])
  const identity = deriveIdentity({ sessionId: 's1', purpose: 'auto-review', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'approval', thread: 's1#review', trace: 's1:review' })
})

test('title and approval can each follow the main conversation', () => {
  const getSession = world([session('s1')])
  const title = deriveIdentity({
    sessionId: 's1',
    purpose: 'session-title',
    settings: settings({ titleThread: 'shared' }),
    getSession,
  })
  assert.deepEqual(title, { kind: 'title', thread: 's1', trace: 's1:title' })

  const approval = deriveIdentity({
    sessionId: 's1',
    purpose: 'auto-review',
    settings: settings({ approvalThread: 'shared' }),
    getSession,
  })
  assert.deepEqual(approval, { kind: 'approval', thread: 's1', trace: 's1:review' })

  const split = deriveIdentity({
    sessionId: 's1',
    purpose: 'auto-review',
    settings: settings({ titleThread: 'shared', approvalThread: 'own' }),
    getSession,
  })
  assert.equal(split.thread, 's1#review')
})

test('an unknown purpose stays in its own side thread', () => {
  const getSession = world([session('s1')])
  const identity = deriveIdentity({ sessionId: 's1', purpose: 'some aux call', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'system', thread: 's1#other', trace: 's1:psome_aux_call' })
})

test('a subagent gets its own thread and a parent-prefixed trace', () => {
  const child = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep', delegationDepth: 1 },
    log: [{ type: 'turn/start', data: { turn: 2 } }],
  })
  const getSession = world([session('s1'), child])
  const identity = deriveIdentity({ sessionId: 'c1', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'subagent', thread: 'c1', trace: `s1:cdeep.${tag('c1')}:t2` })
})

test('a subagent can fold into the root conversation thread', () => {
  const child = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep' },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const getSession = world([session('s1'), child])
  const identity = deriveIdentity({
    sessionId: 'c1',
    settings: settings({ subagentThread: 'parent' }),
    getSession,
  })
  assert.deepEqual(identity, { kind: 'subagent', thread: 's1', trace: `s1:cdeep.${tag('c1')}:t1` })
})

test('a nested subagent walks up one hop at a time', () => {
  const child = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep' },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const grandchild = session('c2', {
    header: { origin: 'subagent', parentSession: 'c1', agentPreset: 'writer', delegationDepth: 2 },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const getSession = world([session('s1'), child, grandchild])
  const identity = deriveIdentity({ sessionId: 'c2', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'subagent', thread: 'c2', trace: `c1:cwriter.${tag('c2')}:t1` })
  assert.equal(rootOf(getSession, 'c2'), 's1')
})

test('a forked session without the subagent origin stays a normal session', () => {
  const forked = session('f1', { header: { parentSession: 's1' }, log: [] })
  const getSession = world([session('s1'), forked])
  assert.equal(subagentOf(forked), null)
  const identity = deriveIdentity({ sessionId: 'f1', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'user', thread: 'f1', trace: 'f1:t0' })
})

test('the last turn survives a finished turn', () => {
  const getSession = world([
    session('s1', {
      log: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1 } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'turn/end', data: { turn: 2 } },
      ],
    }),
  ])
  assert.equal(lastTurn(getSession('s1')), 2)
})

test('turn tracking off removes only the turn suffix', () => {
  const child = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep' },
    log: [{ type: 'turn/start', data: { turn: 5 } }],
  })
  const getSession = world([session('s1', { log: [{ type: 'turn/start', data: { turn: 7 } }] }), child])
  const off = settings({ turnTracking: false })

  assert.deepEqual(deriveIdentity({ sessionId: 's1', settings: off, getSession }), {
    kind: 'user',
    thread: 's1',
    trace: 's1',
  })
  assert.deepEqual(deriveIdentity({ sessionId: 's1', purpose: 'compaction', settings: off, getSession }), {
    kind: 'compaction',
    thread: 's1',
    trace: 's1',
  })
  assert.deepEqual(deriveIdentity({ sessionId: 'c1', settings: off, getSession }), {
    kind: 'subagent',
    thread: 'c1',
    trace: `s1:cdeep.${tag('c1')}`,
  })
  // Side requests keep their fixed suffix; the switch must not reclassify them.
  assert.deepEqual(deriveIdentity({ sessionId: 's1', purpose: 'session-title', settings: off, getSession }), {
    kind: 'title',
    thread: 's1#title',
    trace: 's1:title',
  })
  assert.deepEqual(deriveIdentity({ sessionId: 's1', purpose: 'auto-review', settings: off, getSession }), {
    kind: 'approval',
    thread: 's1#review',
    trace: 's1:review',
  })
})

test('hashed mode emits short hex values only', () => {
  const getSession = world([session('s1', { log: [{ type: 'turn/start', data: { turn: 1 } }] })])
  const identity = deriveIdentity({ sessionId: 's1', settings: settings({ hashIds: true }), getSession })
  assert.match(identity.thread, /^[0-9a-f]{16}$/u)
  assert.match(identity.trace, /^[0-9a-f]{16}$/u)
  assert.notEqual(identity.thread, identity.trace)
})

test('a request without a session is left alone', () => {
  const getSession = world([])
  assert.equal(deriveIdentity({ sessionId: undefined, settings: settings(), getSession }), null)
  assert.equal(deriveIdentity({ sessionId: '', settings: settings(), getSession }), null)
})

test('a missing session still produces a stable value', () => {
  const getSession = world([])
  const identity = deriveIdentity({ sessionId: 'ghost', settings: settings(), getSession })
  assert.deepEqual(identity, { kind: 'user', thread: 'ghost', trace: 'ghost:t0' })
})

test('two subagents with the same parent and preset stay apart', () => {
  const first = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep' },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const second = session('c2', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: 'deep' },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const getSession = world([session('s1'), first, second])
  const a = deriveIdentity({ sessionId: 'c1', settings: settings(), getSession })
  const b = deriveIdentity({ sessionId: 'c2', settings: settings(), getSession })
  assert.notEqual(a.trace, b.trace)
  assert.equal(a.trace, `s1:cdeep.${tag('c1')}:t1`)
  assert.equal(b.trace, `s1:cdeep.${tag('c2')}:t1`)
})

test('a localized preset cannot put non ASCII into a header value', () => {
  const child = session('c1', {
    header: { origin: 'subagent', parentSession: 's1', agentPreset: '写作小组' },
    log: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const getSession = world([session('s1'), child])
  const identity = deriveIdentity({ sessionId: 'c1', settings: settings(), getSession })
  assert.match(identity.trace, /^[\x20-\x7E]+$/u)
  assert.equal(identity.trace, `s1:cagent.${tag('c1')}:t1`)
})
