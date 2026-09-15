/**
 * Source: the dsh.works registry (`awesome-dsh-plugins`).
 *
 * A machine-first registry: every entry names the file its install path was
 * PROVEN in, plus the dsh version that was checked against, so it can state
 * things the prose catalogs cannot. It is also the only source besides the
 * GitHub topic that is large (~13k plugin entries) while still being
 * spam-filtered — upstream rejects ~2.3k of the ~16.9k topic repos it scans.
 *
 * Two deliberate filters:
 *   - `category !== 'plugin'` is dropped. The same registry also lists core
 *     bundles (dsh-base, dsh-web-app), skills, themes and tools; a bundle is
 *     official core, so surfacing it as "a plugin you could install" is noise.
 *   - `status === 'broken'` is dropped: the install path it once proved no
 *     longer exists upstream. `unverified` is KEPT and labelled — an entry
 *     nobody has re-checked is still a real plugin, and hiding it would
 *     silently shrink the ecosystem.
 *
 * @module dsh-find-plugins/sources/dshworks
 */

import { fetchJson } from '../cache.js'
import { entry } from '../merge.js'

export const id = 'dsh.works'
export const label = 'dsh.works'
export const url = 'https://dsh.works/awesome-dsh-plugins/plugins.json'

const TTL_MS = 30 * 60_000
const TIMEOUT_MS = 25_000

export async function load () {
  const res = await fetchJson(url, { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { ok: false, error: res.error, entries: [] }
  const plugins = Array.isArray(res.value?.plugins) ? res.value.plugins : []
  return { ok: true, stale: res.stale === true, entries: plugins.map(normalize).filter(Boolean) }
}

/** `owner/name`, or null. */
function repoOf (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : null
}

export function normalize (plugin) {
  if (plugin === null || typeof plugin !== 'object') return null
  if (plugin.category !== 'plugin') return null
  if (plugin.status === 'broken') return null

  const repo = repoOf(plugin.repo)
  if (repo === null && typeof plugin.npm !== 'string') return null

  const tags = Array.isArray(plugin.tags) ? plugin.tags.filter((t) => typeof t === 'string') : []

  const notes = []
  if (plugin.status === 'unverified') notes.push('安装路径未复核')
  if (plugin.official === true) notes.push('官方')

  return entry({
    source: id,
    repo,
    name: plugin.name,
    description: plugin.description,
    stars: plugin.stars,
    pushedAt: plugin.pushedAt,
    npm: plugin.npm,
    // `path` is the package's directory inside a monorepo — without it the
    // install lands on the collection root and produces the wrong package.
    path: plugin.path,
    // ALL tags go into the searchable text: they are the functional areas
    // (memory / terminal / vision …) and are often the only English vocabulary
    // an entry has.
    topics: tags,
    category: tags[0] ?? null,
    compat: plugin.verifiedAgainst
      ? { version: String(plugin.verifiedAgainst), at: plugin.lastVerified ?? null }
      : null,
    notes,
  })
}