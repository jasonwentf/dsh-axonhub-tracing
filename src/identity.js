// Work out the two identifiers written on every outbound request.
//
// Thread answers "which conversation does this belong to".
// Trace answers "which turn or side task is this".
//
// Everything here is synchronous. The caller passes a session getter so the
// derivation stays testable without a running harness.

import { createHash } from 'node:crypto'

const MAX_LABEL = 24
const MAX_DEPTH = 32
// Header values must stay inside printable ASCII. Labels are restricted to the
// same set so a localized agent preset can never make the fetch layer throw.
const SAFE_LABEL = /[^A-Za-z0-9._-]+/gu

export function shortLabel(value, fallback = 'x') {
  const source = typeof value === 'string' ? value.trim() : ''
  const cleaned = source.replace(SAFE_LABEL, '_').replace(/^_+|_+$/gu, '').slice(0, MAX_LABEL)
  return cleaned === '' ? fallback : cleaned
}

// Two subagents can share a parent and a preset at the same time. Hashing the
// child session id keeps their traces apart even when the ids share a prefix,
// which a plain leading slice cannot guarantee.
function childTag(sessionId) {
  return hashValue(sessionId).slice(0, 8)
}

export function lastTurn(session) {
  const log = session?.log
  if (!Array.isArray(log)) return null
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) return event.data.turn
  }
  return null
}

export function subagentOf(session) {
  const header = session?.header
  if (!header || header.origin !== 'subagent') return null
  const parent = typeof header.parentSession === 'string' ? header.parentSession : null
  const label = shortLabel(header.agentPreset, 'agent')
  return { parent, label }
}

export function rootOf(getSession, sessionId) {
  let current = sessionId
  const seen = new Set()
  for (let step = 0; step < MAX_DEPTH && typeof current === 'string' && current !== ''; step += 1) {
    if (seen.has(current)) return current
    seen.add(current)
    const sub = subagentOf(getSession(current))
    if (!sub || !sub.parent) return current
    current = sub.parent
  }
  return current
}

export function hashValue(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

// Purpose comes from the harness itself, so no request-body inspection is
// needed. Unknown purposes still belong to the session but are never mixed
// into a user turn.
//
// `tag` is the fixed suffix for a side request. A null tag means the request
// follows turn tracking: compaction, ordinary turns and subagent turns.
function classify(purpose, sub) {
  if (purpose === 'session-title') return { kind: 'title', tag: 'title' }
  if (purpose === 'auto-review') return { kind: 'approval', tag: 'review' }
  if (purpose === 'compaction') return { kind: 'compaction', tag: null }
  if (typeof purpose === 'string' && purpose.trim() !== '') {
    return { kind: 'system', tag: `p${shortLabel(purpose, 'other')}` }
  }
  return { kind: sub ? 'subagent' : 'user', tag: null }
}

export function deriveIdentity({ sessionId, purpose, settings, getSession }) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const session = getSession(sessionId)
  const sub = subagentOf(session)
  const turn = lastTurn(session)
  const { kind, tag } = classify(purpose, sub)

  // The thread is the conversation. Only the subagent switch and the two side
  // request switches can move a request out of it.
  let thread
  if (sub) {
    thread = settings.subagentThread === 'parent' ? rootOf(getSession, sessionId) : sessionId
  } else if (kind === 'title') {
    thread = settings.titleThread === 'shared' ? sessionId : `${sessionId}#title`
  } else if (kind === 'approval') {
    thread = settings.approvalThread === 'shared' ? sessionId : `${sessionId}#review`
  } else if (kind === 'system') {
    thread = `${sessionId}#other`
  } else {
    thread = sessionId
  }

  // Turn tracking only controls the per turn suffix. Title, approval and other
  // auxiliary calls keep their fixed suffix either way, so the switch never
  // changes how they are grouped.
  let tail = ''
  if (tag !== null) tail = `:${tag}`
  else if (settings.turnTracking) tail = `:t${turn ?? 0}`

  const lineage = sub && sub.parent ? `${sub.parent}:c${sub.label}.${childTag(sessionId)}` : sessionId
  const trace = `${lineage}${tail}`

  return {
    kind,
    thread: settings.hashIds ? hashValue(thread) : thread,
    trace: settings.hashIds ? hashValue(trace) : trace,
  }
}
