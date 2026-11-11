// Which providers get tracing headers.
//
// auto  : provider id, provider name or base URL contains "axon"
// all   : every provider that reaches the pi-ai request-header hook
// none  : nothing, until the user ticks a provider in the settings card
//
// A provider listed in `overrides` always wins over the mode, so a new provider
// follows the mode automatically and an existing one can be forced either way.

const AUTO_MATCH = /axon/iu

function overrideFor(map, provider) {
  if (Object.prototype.hasOwnProperty.call(map, provider)) return map[provider]
  const lowered = provider.toLowerCase()
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === lowered) return value
  }
  return undefined
}

export function shouldTag(settings, provider, baseURL) {
  if (!settings.enabled) return false
  const id = typeof provider === 'string' ? provider : ''
  const forced = overrideFor(settings.overrides, id)
  if (forced !== undefined) return forced
  if (settings.mode === 'all') return true
  if (settings.mode === 'none') return false
  return AUTO_MATCH.test(id) || AUTO_MATCH.test(String(baseURL ?? ''))
}

export function autoMatches(provider, baseURL) {
  return AUTO_MATCH.test(String(provider ?? '')) || AUTO_MATCH.test(String(baseURL ?? ''))
}
