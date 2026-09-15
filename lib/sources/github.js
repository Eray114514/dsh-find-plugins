/**
 * Source: live GitHub topic search.
 *
 * The only source that can surface a plugin published TODAY — every catalog
 * lags by up to a day. It is also the noisiest (any repo that tags the topic
 * shows up, including general agent frameworks) and the only rate-limited
 * one, so it is ranked lowest and treated as a widening net rather than the
 * primary answer.
 *
 * Four deliberate choices, each measured:
 *   - it pages, instead of reading one page and calling it a day;
 *   - `per_page=100` (the API maximum) instead of 30: the same one request per
 *     topic covers 3x the candidates, which matters because the anonymous
 *     search budget is 10 requests per MINUTE;
 *   - it searches BOTH topic spellings. `topic:dsh-plugins` (plural) holds 66
 *     repositories that `topic:dsh-plugin` does not, and real plugins are among
 *     them. GitHub rejects `topic:a OR topic:b`, so this costs a second request
 *     rather than a wider query;
 *   - it keeps GitHub's own relevance ordering instead of immediately
 *     re-sorting by stars. Re-sorting by stars is what lets a ★72k library
 *     that merely tagged the topic bury the actual plugin (measured: for
 *     "memory" the top 8 by stars contained zero DSH plugins). Trust and
 *     freshness weighting belongs in rank.js, where it can see every source.
 *
 * Anonymous search allows 10 requests/minute per IP; a 403 is reported as a
 * normal source failure so the caller can say "this source was rate limited"
 * rather than silently returning a short list.
 *
 * @module dsh-find-plugins/sources/github
 */

import { fetchJson } from '../cache.js'
import { entry } from '../merge.js'

export const id = 'github'
export const label = 'GitHub topic'

export const TOPICS = ['dsh-plugin', 'dsh-plugins']

const TTL_MS = 5 * 60_000
const TIMEOUT_MS = 15_000
const PER_PAGE = 100
const MAX_PAGES = 2

export function searchUrl (query, topic = TOPICS[0], page = 1, perPage = PER_PAGE) {
  const q = encodeURIComponent(`${query} topic:${topic}`)
  return `https://api.github.com/search/repositories?q=${q}&per_page=${perPage}&page=${page}`
}

function headers () {
  // DSH_FIND_PLUGINS_GITHUB_TOKEN is optional and only raises the GitHub search
  // rate limit for anonymous users (60/h -> 5000/h). GITHUB_TOKEN is honoured
  // too, since it is the conventional name most environments already set.
  const token = process.env.DSH_FIND_PLUGINS_GITHUB_TOKEN ||
    process.env.SCOUT_GITHUB_TOKEN || // pre-rename name, kept for compatibility
    process.env.GITHUB_TOKEN
  return token ? { authorization: `Bearer ${token}` } : undefined
}

export async function load ({ query, pages = 1 } = {}) {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return { ok: true, entries: [], total: 0 }

  const wanted = Math.max(1, Math.min(Number(pages) || 1, MAX_PAGES))
  const entries = []
  const seen = new Set()
  let total = 0
  let stale = false

  for (const topic of TOPICS) {
    for (let page = 1; page <= wanted; page += 1) {
      const res = await fetchJson(searchUrl(trimmed, topic, page), {
        ttlMs: TTL_MS,
        timeoutMs: TIMEOUT_MS,
        headers: headers(),
      })
      if (!res.ok) {
        // The FIRST request failing means the source failed (rate limit, auth);
        // a later page failing just means we got fewer candidates, which is not
        // worth discarding what we already have.
        if (topic === TOPICS[0] && page === 1) return { ok: false, error: res.error, entries: [] }
        break
      }
      if (res.stale === true) stale = true
      if (typeof res.value?.total_count === 'number') total += res.value.total_count
      const items = Array.isArray(res.value?.items) ? res.value.items : []
      for (const item of items) {
        const normalized = normalize(item)
        // The two topics overlap heavily; a repo tagging both must not be
        // counted, ranked, or corroboration-counted twice.
        if (normalized !== null && !seen.has(normalized.key)) {
          seen.add(normalized.key)
          entries.push(normalized)
        }
      }
      if (items.length < PER_PAGE) break
    }
  }

  return { ok: true, stale, total, entries }
}

export function normalize (item) {
  if (item === null || typeof item !== 'object') return null
  const repo = typeof item.full_name === 'string' ? item.full_name : null
  if (repo === null) return null
  const topics = Array.isArray(item.topics)
    ? item.topics.filter((t) => typeof t === 'string' && !TOPICS.includes(t))
    : []
  return entry({
    source: id,
    repo,
    url: item.html_url,
    description: item.description,
    stars: item.stargazers_count,
    pushedAt: item.pushed_at,
    archived: item.archived === true,
    license: item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION' ? item.license.spdx_id : null,
    category: topics[0] ?? null,
    topics,
  })
}
