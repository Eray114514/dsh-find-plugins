/**
 * Source: awesome-dsh-plugin.com curated list.
 *
 * A human-maintained list with hand-written bilingual descriptions — the
 * best prose of any source — plus an explicit npm name when the plugin is
 * published, which is exactly what the install target needs.
 *
 * @module dsh-find-plugins/sources/awesome
 */

import { fetchJson } from '../cache.js'
import { entry, npmNameFromTarget, repoFromUrl } from '../merge.js'

export const id = 'awesome'
export const label = 'awesome-dsh-plugin'
export const url = 'https://awesome-dsh-plugin.com/plugins.json'

const TTL_MS = 30 * 60_000
const TIMEOUT_MS = 25_000

export async function load () {
  const res = await fetchJson(url, { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { ok: false, error: res.error, entries: [] }
  const plugins = Array.isArray(res.value?.plugins) ? res.value.plugins : []
  return { ok: true, stale: res.stale === true, entries: plugins.map(normalize).filter(Boolean) }
}

export function normalize (plugin) {
  if (plugin === null || typeof plugin !== 'object') return null
  const repo = repoFromUrl(plugin.url) || (typeof plugin.name === 'string' && typeof plugin.owner === 'string'
    ? `${plugin.owner}/${plugin.name}`
    : null)
  if (repo === null) return null

  // `npm` is the authoritative field; the install command is the fallback.
  const npm = plugin.npm || npmNameFromTarget(plugin.install) || null

  return entry({
    source: id,
    repo,
    description: plugin.description,
    stars: plugin.stars,
    npm,
    category: plugin.category || null,
  })
}
