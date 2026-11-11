import { install } from './src/host.js'

export const name = 'dsh-axonhub-tracing'
export const inject = []

export function apply(ctx, config) {
  install(ctx, config)
}
