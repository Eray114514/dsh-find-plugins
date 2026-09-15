/**
 * Source registry: load every source concurrently and never let one failure
 * take down the answer.
 *
 * Catalogs are fetched once and cached (they are large and change slowly);
 * the GitHub search is per-query and short-lived. All five are independent —
 * a source that fails reports its own status and contributes nothing, and the
 * caller relays that status so the agent can tell "the ecosystem has three of
 * these" from "one catalog was down".
 *
 * @module dsh-find-plugins/sources
 */

import * as awesome from './awesome.js'
import * as dshso from './dshso.js'
import * as github from './github.js'
import * as lanshu from './lanshu.js'
import * as radar from './radar.js'
import { shortError } from '../cache.js'

export const CATALOG_SOURCES = [dshso, radar, lanshu, awesome]
export const SEARCH_SOURCE = github
export const ALL_SOURCES = [...CATALOG_SOURCES, SEARCH_SOURCE]

/** Run one source, converting any throw into a status. */
export async function loadOne (source, args) {
  try {
    const result = await source.load(args)
    return {
      ok: result.ok === true,
      error: result.ok === true ? undefined : (result.error || 'unavailable'),
      stale: result.stale === true,
      entries: Array.isArray(result.entries) ? result.entries : [],
    }
  } catch (error) {
    return { ok: false, error: shortError(error), stale: false, entries: [] }
  }
}

/**
 * @returns {{ sources: Record<string, object>, entries: object[] }}
 *   `sources` is the per-source status the renderer reports; `entries` is the
 *   concatenation of everything that succeeded, still un-merged and un-ranked.
 */
export async function loadAll ({ query, githubPages = 2 } = {}) {
  const sources = {}
  const entries = []

  const tasks = [
    ...CATALOG_SOURCES.map((source) => (async () => {
      const result = await loadOne(source)
      sources[source.id] = {
        ok: result.ok,
        error: result.error,
        stale: result.stale,
        count: result.entries.length,
        label: source.label,
      }
      entries.push(...result.entries)
    })()),
    (async () => {
      const result = await loadOne(SEARCH_SOURCE, { query, pages: githubPages })
      sources[SEARCH_SOURCE.id] = {
        ok: result.ok,
        error: result.error,
        stale: result.stale,
        count: result.entries.length,
        label: SEARCH_SOURCE.label,
      }
      entries.push(...result.entries)
    })(),
  ]

  await Promise.all(tasks)
  return { sources, entries }
}
