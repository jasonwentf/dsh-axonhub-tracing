// Settings shape, defaults and validation.
//
// This module stays free of harness imports so it can be unit tested outside
// the app. The schemastery projection lives in schema.js.

export const DEFAULT_HEADERS = Object.freeze({
  thread: 'AH-Thread-Id',
  trace: 'AH-Trace-Id',
  kind: 'AH-Kind',
})

export const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'auto',
  overrides: Object.freeze({}),
  threadHeader: DEFAULT_HEADERS.thread,
  traceHeader: DEFAULT_HEADERS.trace,
  kindHeader: DEFAULT_HEADERS.kind,
  emitSessionHeader: false,
  // Whether every user turn gets its own trace suffix. The conversation thread
  // stays the same either way, so channel stickiness is unaffected.
  turnTracking: true,
  subagentThread: 'own',
  titleThread: 'own',
  approvalThread: 'own',
  hashIds: false,
  recentLimit: 20,
  debug: false,
})

export const MODES = Object.freeze(['auto', 'all', 'none'])
export const SUBAGENT_THREADS = Object.freeze(['own', 'parent'])
export const SIDE_THREADS = Object.freeze(['own', 'shared'])

// RFC 7230 token. A header name outside this set would make the host reject the
// whole request before it is sent, so it falls back to the default.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const MAX_RECENT = 50

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function headerName(value, fallback) {
  const name = text(value)
  return name !== '' && HEADER_NAME.test(name) ? name : fallback
}

export function assertHeaderName(value) {
  return typeof value === 'string' && HEADER_NAME.test(value)
}

function overrides(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, flag] of Object.entries(value)) {
    const id = text(key)
    if (id === '' || typeof flag !== 'boolean') continue
    result[id] = flag
  }
  return result
}

function recentLimit(value) {
  if (!Number.isFinite(value)) return DEFAULTS.recentLimit
  return Math.max(1, Math.min(MAX_RECENT, Math.floor(value)))
}

// Names the transport layer owns. Writing one of these would either be
// overwritten by the harness (user-agent) or break the request outright
// (content-length, authorization).
const RESERVED_HEADERS = new Set([
  'user-agent',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'anthropic-version',
  'content-type',
  'content-length',
  'host',
  'accept',
  'accept-encoding',
  'connection',
  'cookie',
  'transfer-encoding',
])

function ours(value, fallback) {
  const name = headerName(value, fallback)
  return RESERVED_HEADERS.has(name.toLowerCase()) ? fallback : name
}

export function normalizeSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  let threadHeader = ours(source.threadHeader, DEFAULTS.threadHeader)
  let traceHeader = ours(source.traceHeader, DEFAULTS.traceHeader)
  let kindHeader =
    source.kindHeader === '' ? '' : ours(source.kindHeader, DEFAULTS.kindHeader)

  // Two headers with the same name would silently overwrite each other, so a
  // collision resets the pair to the documented defaults.
  if (threadHeader.toLowerCase() === traceHeader.toLowerCase()) {
    threadHeader = DEFAULTS.threadHeader
    traceHeader = DEFAULTS.traceHeader
  }
  // A third header that duplicates one of the first two carries no information.
  if (
    kindHeader !== '' &&
    [threadHeader, traceHeader].some((name) => name.toLowerCase() === kindHeader.toLowerCase())
  ) {
    kindHeader = ''
  }

  // Older builds stored one shared switch for side requests and a session
  // granularity mode. Map them onto the split settings so an existing file
  // keeps its meaning.
  const legacySide = source.internalThread
  const sideDefault = legacySide === 'shared' ? 'shared' : 'own'
  const turnTracking = bool(
    source.turnTracking,
    source.traceGranularity === 'session' ? false : DEFAULTS.turnTracking,
  )

  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    mode: oneOf(source.mode, MODES, DEFAULTS.mode),
    overrides: overrides(source.overrides),
    threadHeader,
    traceHeader,
    kindHeader,
    emitSessionHeader: bool(source.emitSessionHeader, DEFAULTS.emitSessionHeader),
    turnTracking,
    subagentThread: oneOf(source.subagentThread, SUBAGENT_THREADS, DEFAULTS.subagentThread),
    titleThread: oneOf(source.titleThread, SIDE_THREADS, sideDefault),
    approvalThread: oneOf(source.approvalThread, SIDE_THREADS, sideDefault),
    hashIds: bool(source.hashIds, DEFAULTS.hashIds),
    recentLimit: recentLimit(source.recentLimit),
    debug: bool(source.debug, DEFAULTS.debug),
  }
}

// The settings card edits a patch, so every field it sends is merged over the
// current document and then normalised as a whole.
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current)
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  return normalizeSettings({ ...base, ...patch })
}
