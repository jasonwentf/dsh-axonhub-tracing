// Settings document and the recent-request ring.
//
// The plugin owns this file. The settings card is only a view over it, so the
// same values can be edited by hand when the app is closed.
//
// Default location: $DSH_HOME/axonhub-tracing/settings.json
// which is ~/.dsh/axonhub-tracing/settings.json unless DSH_HOME is set.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DEFAULTS, normalizeSettings } from './config.js'

const MAX_RECENT = 50

export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : path.join(homedir(), '.dsh')
}

export function settingsFile() {
  return path.join(dshHome(), 'axonhub-tracing', 'settings.json')
}

export class SettingsStore {
  constructor(file, initial) {
    this.file = file
    this.settings = normalizeSettings(initial ?? DEFAULTS)
    this.entries = []
    this.logger = null
    this.saved = true
  }

  readFile() {
    try {
      if (!existsSync(this.file)) return null
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    } catch (error) {
      this.logger?.warn?.(`[axonhub-tracing] settings file is unreadable, keeping the running values: ${error.message}`)
      return null
    }
  }

  load() {
    if (!existsSync(this.file)) return this.settings
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('settings file is not a JSON object')
      }
      this.settings = normalizeSettings({ ...this.settings, ...raw })
    } catch (error) {
      // A file the user cannot read is not a reason to quietly start tagging
      // again. Keep the plugin off until the file is fixed or replaced.
      this.settings = normalizeSettings({ ...this.settings, enabled: false })
      this.logger?.warn?.(
        `[axonhub-tracing] settings file is unreadable, tracing stays off: ${error.message}`,
      )
    }
    return this.settings
  }

  get() {
    return this.settings
  }

  update(patch) {
    // Re-read the file first: another harness process may have written since
    // this one loaded. Merging the patch over the freshest copy narrows a lost
    // update down to the fields both sides touched at the same instant.
    const onDisk = this.readFile()
    const base = onDisk === null ? this.settings : normalizeSettings({ ...this.settings, ...onDisk })
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
      this.settings = normalizeSettings({ ...base, ...patch })
    } else {
      this.settings = base
    }
    this.save()
    this.trim()
    return this.settings
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      // A unique temporary name keeps two harness processes from racing on the
      // same file when both write their settings at once.
      const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.file)
      this.saved = true
    } catch (error) {
      this.saved = false
      this.logger?.warn?.(`[axonhub-tracing] settings file is not writable: ${error.message}`)
    }
    return this.saved
  }

  record(entry) {
    this.entries.push(entry)
    this.trim()
  }

  trim() {
    const limit = Math.min(MAX_RECENT, this.settings.recentLimit)
    while (this.entries.length > limit) this.entries.shift()
  }

  recent() {
    return this.entries.slice().reverse()
  }
}
