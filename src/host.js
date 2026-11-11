// Host half: read the live settings, decide, and stamp the headers.
//
// The harness exposes `llm-pi-ai/request-headers` for exactly this job. The
// listener runs synchronously before each inference request, gets a mutable
// copy of the profile headers, and must call next().

import { autoMatches, shouldTag } from './policy.js'
import { deriveIdentity, hashValue } from './identity.js'
import { SettingsStore, settingsFile } from './store.js'

const SERVICE = 'axonhubTracing'
// Fetch rejects anything outside printable ASCII, so the whole set is checked
// before the first header is written. A half-stamped request would leave the
// gateway with a thread but no trace.
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/u

function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function preview(value, keep = 28) {
  const text = String(value ?? '')
  return text.length <= keep ? text : `…${text.slice(-keep + 1)}`
}

export function install(ctx, config) {
  const store = new SettingsStore(settingsFile(), config)
  store.logger = ctx.logger
  store.load()

  let warnedNoSessions = false

  const settings = () => store.get()
  const getSession = (sessionId) => {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions === undefined) {
      if (!warnedNoSessions && settings().debug) {
        warnedNoSessions = true
        ctx.logger?.warn?.('[axonhub-tracing] sessions service is not available; turn numbers fall back to 0')
      }
      return undefined
    }
    try {
      return sessions.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  const baseURLs = new Map()

  // Only the scheme and host are kept. Credentials, paths and query strings in
  // a configured URL have no business reaching the status card.
  function originOf(baseURL) {
    try {
      return new URL(baseURL).origin
    } catch {
      return null
    }
  }

  function stamp(request, headers) {
    const current = settings()
    const provider = String(request?.provider ?? '')
    const baseURL = typeof request?.baseURL === 'string' ? request.baseURL : ''
    if (!shouldTag(current, provider, baseURL)) return null
    const origin = originOf(baseURL)
    if (origin !== null) baseURLs.set(provider, origin)

    const identity = deriveIdentity({
      sessionId: request?.sessionId === undefined ? undefined : String(request.sessionId),
      purpose: request?.purpose,
      settings: current,
      getSession,
    })
    if (identity === null) return null

    const planned = [
      [current.threadHeader, identity.thread],
      [current.traceHeader, identity.trace],
    ]
    if (current.kindHeader !== '') planned.push([current.kindHeader, identity.kind])
    if (current.emitSessionHeader && typeof request?.sessionId === 'string') {
      const sessionValue = current.hashIds
        ? hashValue(String(request.sessionId))
        : String(request.sessionId)
      planned.push(['X-Session-Id', sessionValue])
    }
    for (const [name, value] of planned) {
      if (!PRINTABLE_ASCII.test(value)) {
        ctx.logger?.warn?.(
          `[axonhub-tracing] skipped ${provider}: a header value contains characters HTTP cannot carry`,
        )
        return null
      }
    }
    for (const [name, value] of planned) headers.set(name, value)

    store.record({
      at: Date.now(),
      provider,
      model: typeof request?.model === 'string' ? request.model : String(request?.model ?? ''),
      purpose: typeof request?.purpose === 'string' ? request.purpose : null,
      kind: identity.kind,
      thread: preview(identity.thread),
      trace: preview(identity.trace),
    })

    if (current.debug) {
      ctx.logger?.info?.(
        `[axonhub-tracing] ${provider}/${String(request?.model ?? '')} ${identity.kind} ${identity.trace}`,
      )
    }
    return identity
  }

  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    try {
      stamp(request, headers)
    } catch (error) {
      // Never turn a tracing bug into a failed model call.
      ctx.logger?.warn?.(`[axonhub-tracing] header stamping failed: ${error?.message ?? error}`)
    }
    return next()
  })

  class TracingRemote {
    constructor() {
      this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE, namespace: SERVICE })
      Object.defineProperty(this, Symbol.for('cordis.tracker'), {
        value: { associate: SERVICE, property: 'ctx' },
      })
    }

    async getState() {
      let providers = []
      try {
        const llm = serviceOf(ctx, 'llm')
        providers = (llm?.listProviders?.() ?? []).map((provider) => {
          const id = String(provider?.id ?? '')
          const name = String(provider?.name ?? id)
          const baseURL = baseURLs.get(id) ?? null
          return { id, name, baseURL, auto: autoMatches(id, baseURL) }
        })
      } catch (error) {
        ctx.logger?.warn?.(`[axonhub-tracing] provider listing failed: ${error?.message ?? error}`)
      }
      return { settings: settings(), providers, recent: store.recent(), persisted: store.saved }
    }

    async updateSettings(patch) {
      const next = store.update(patch)
      return { settings: next, persisted: store.saved }
    }

    // One provider at a time. The client never sends the whole override map, so
    // two quick toggles cannot overwrite each other with a stale copy.
    async setProvider(id, value) {
      if (typeof id !== 'string' || id === '') throw new Error('provider id is required')
      const next = { ...store.get().overrides }
      if (value === null || value === undefined) delete next[id]
      else next[id] = Boolean(value)
      const settings = store.update({ overrides: next })
      return { settings, persisted: store.saved }
    }
  }

  Object.defineProperty(TracingRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'getState', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'updateSettings', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'setProvider', invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })

  ctx.provide(SERVICE, new TracingRemote())
}
