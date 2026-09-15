/**
 * Source registry: load every source concurrently and never let one failure
 * take down the answer.
 *
 * Catalogs are fetched once and cached (they are large and change slowly);
 * the query-scoped sources (GitHub topic search, npm search) are per-query and
 * short-lived. All of them are independent — a source that fails reports its
 * own status and contributes nothing, and the caller relays that status so the
 * agent can tell "the ecosystem has three of these" from "one catalog was
 * down".
 *
 * @module dsh-find-plugins/sources
 */

import * as awesome from './awesome.js'
import * as dshso from './dshso.js'
import * as dshworks from './dshworks.js'
import * as github from './github.js'
import * as lanshu from './lanshu.js'
import * as npm from './npm.js'
import * as radar from './radar.js'
import { shortError } from '../cache.js'

export const CATALOG_SOURCES = [dshso, dshworks, radar, lanshu, awesome]
export const SEARCH_SOURCES = [github, npm]
export const ALL_SOURCES = [...CATALOG_SOURCES, ...SEARCH_SOURCES]

/**
 * Hard ceiling on how long one source may hold up the answer.
 *
 * The per-source fetch timeouts bound a REQUEST; this bounds the CALL. Without
 * it a single slow endpoint (one catalog handler is 60s) can leave the caller
 * waiting a minute for an answer that four other sources could already give.
 * The losing source reports `timeout`, and because its request keeps running
 * in the background it lands in the TTL cache — the next call is warm.
 */
const DEFAULT_BUDGET_MS = 25_000

/** Resolve `promise` as a source result, or as a timeout once `ms` elapses. */
async function withBudget (promise, ms) {
  let timer
  const expiry = new Promise((resolve) => {
    // NOT unref'd, deliberately: this timer is the only thing that can settle a
    // call whose source never answers. Unref'd, a hang would leave the promise
    // pending for as long as nothing else held the event loop open — which is
    // exactly the case the budget exists for (a headless run, a test) and the
    // reason Node 22's runner reported "Promise resolution is still pending but
    // the event loop has already resolved" instead of the timeout.
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout', entries: [] }), ms)
  })
  try {
    return await Promise.race([promise, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/** Run one source, converting any throw into a status. */
export async function loadOne (source, args, budgetMs = DEFAULT_BUDGET_MS) {
  const started = Promise.resolve()
    .then(() => source.load(args))
    .then(
      (result) => {
        // Build without `error` / `stale` when the value is undefined — JSON.stringify
        // silently drops undefined keys, which would make the framework's
        // lossless-JSON validation reject the whole tool output.
        return {
          ok: result.ok === true,
          ...(result.ok === true ? {} : { error: result.error || 'unavailable' }),
          ...(result.stale === true && { stale: true }),
          ...(Number.isFinite(result.total) && { total: result.total }),
          entries: Array.isArray(result.entries) ? result.entries : [],
        }
      },
      (error) => ({ ok: false, error: shortError(error), entries: [] }),
    )
  return withBudget(started, budgetMs)
}

/** The status the renderer reports, derived from one load result. */
function statusOf (source, result) {
  return {
    ok: result.ok,
    label: source.label,
    count: result.entries.length,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.stale === true ? { stale: true } : {}),
    ...(Number.isFinite(result.total) ? { total: result.total } : {}),
  }
}

/**
 * @returns {{ sources: Record<string, object>, entries: object[] }}
 *   `sources` is the per-source status the renderer reports; `entries` is the
 *   concatenation of everything that succeeded, still un-merged and un-ranked.
 */
export async function loadAll ({ query, githubPages = 1, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const sources = {}
  const entries = []

  // Every source gets the FULL budget rather than a share of it: they run
  // concurrently, so a share would only make the slow ones fail earlier for no
  // gain in wall-clock time.
  const tasks = [
    ...CATALOG_SOURCES.map((source) => (async () => {
      const result = await loadOne(source, undefined, budgetMs)
      sources[source.id] = statusOf(source, result)
      entries.push(...result.entries)
    })()),
    ...SEARCH_SOURCES.map((source) => (async () => {
      const result = await loadOne(source, { query, pages: githubPages }, budgetMs)
      sources[source.id] = statusOf(source, result)
      entries.push(...result.entries)
    })()),
  ]

  await Promise.all(tasks)
  return { sources, entries }
}