/**
 * Source: live npm registry search.
 *
 * `dsh plugin add <name>` installs from npm, so npm is the registry the
 * ecosystem actually distributes through — yet a package can declare
 * `keywords: ["dsh-plugin"]` and never appear in any catalog. Measured: of
 * 1000 keyword-matching packages, 297 pointed at a repository no catalog
 * listed, and 91 carried no repository at all (npm was the only place they
 * existed — every one of those sampled did declare `dsh` in its manifest, so
 * they are real plugins that no directory had ever seen).
 *
 * Treated like the GitHub topic search — query-scoped, short TTL — rather than
 * as a catalog: it is a widening net, and its entries carry the weakest
 * evidence tier (`indexed`), because the keyword is self-declared.
 *
 * @module dsh-find-plugins/sources/npm
 */

import { fetchJson } from '../cache.js'
import { entry, repoFromUrl } from '../merge.js'

export const id = 'npm'
export const label = 'npm'
export const url = 'https://registry.npmjs.org'

const TTL_MS = 5 * 60_000
const TIMEOUT_MS = 15_000
const PER_PAGE = 50

/**
 * `text=<query> keywords:dsh-plugin` — free text and the qualifier share one
 * parameter (verified against the live endpoint: the qualifier filters, the
 * free text reorders).
 */
export function searchUrl (query, size = PER_PAGE) {
  return `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${query} keywords:dsh-plugin`)}&size=${size}`
}

export async function load ({ query } = {}) {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return { ok: true, entries: [], total: 0 }

  const res = await fetchJson(searchUrl(trimmed), { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { ok: false, error: res.error, entries: [] }
  const objects = Array.isArray(res.value?.objects) ? res.value.objects : []
  return {
    ok: true,
    stale: res.stale === true,
    total: Number.isFinite(res.value?.total) ? res.value.total : undefined,
    entries: objects.map(normalize).filter(Boolean),
  }
}

export function normalize (item) {
  const pkg = item?.package
  if (pkg === null || typeof pkg !== 'object') return null
  if (typeof pkg.name !== 'string' || pkg.name === '') return null

  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.filter((k) => typeof k === 'string') : []

  return entry({
    source: id,
    // Often absent — a package can be published without a repository field, and
    // those are exactly the entries only npm can surface. `entry()` keys them
    // under `npm:<name>` so they stay distinct from repo-keyed entries.
    repo: repoFromUrl(pkg.links?.repository),
    npm: pkg.name,
    npmVersion: typeof pkg.version === 'string' ? pkg.version : null,
    description: pkg.description,
    // The publish date of the latest version. For an npm-installed plugin this
    // is the honest freshness signal — the repository's push date says nothing
    // about whether the published artifact moved.
    pushedAt: pkg.date,
    license: pkg.license,
    topics: keywords.filter((k) => k !== 'dsh-plugin'),
    category: keywords.find((k) => k !== 'dsh-plugin') ?? null,
  })
}