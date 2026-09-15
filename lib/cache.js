/**
 * Fetch with a TTL cache, single-flight de-duplication, a hard timeout, and
 * stale-if-error.
 *
 * Why each piece exists:
 *   - TTL cache: the GitHub search API allows 10 requests/minute per IP for
 *     anonymous callers (measured: a dozen rapid queries start returning 403),
 *     and the catalog endpoints are multi-megabyte. Re-asking on every tool
 *     call would be both slow and rate-limited.
 *   - single-flight: two concurrent searches must not both pull a 9 MB index.
 *   - timeout: a source that hangs must not hold the whole tool call. One of
 *     the radar endpoints was observed to hang indefinitely, so this is not
 *     hypothetical.
 *   - stale-if-error: an expired copy beats no answer. This is deliberately
 *     NOT a shipped offline index — nothing is persisted, so nothing can go
 *     quietly months out of date; a stale entry only ever survives within one
 *     process, and the caller is told it is stale.
 *   - a size ceiling: the cache outlives every query, and query-scoped URLs
 *     are unbounded, so the oldest entries are evicted once the cap is hit.
 *
 * @module dsh-find-plugins/cache
 */

const DEFAULT_TTL_MS = 30 * 60_000
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The cache lives as long as the dsh process, and every distinct query adds
 * keys (the GitHub and npm search URLs are per-query). Without a ceiling a
 * long-lived server would keep every page of every search anyone ever ran.
 * Eviction is oldest-first: the catalogs are re-fetched when they expire
 * anyway, so losing a warm entry costs one request, not correctness.
 */
const MAX_ENTRIES = 200

const store = new Map()
const inflight = new Map()

function remember (url, value) {
  // Delete first so a refreshed key moves to the newest slot: Map preserves
  // insertion order and eviction reads that order as "least recently written".
  store.delete(url)
  store.set(url, { at: Date.now(), value })
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value)
}

/** Collapse a fetch failure into something short enough to show the model. */
export function shortError (error) {
  if (error === null || error === undefined) return 'unknown error'
  const name = error.name || ''
  const message = String(error.message || error)
  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(message)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'dns'
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)) return 'connection'
  return message.length > 60 ? message.slice(0, 60) + '…' : message
}

async function request (url, { timeoutMs, parse, headers }) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'dsh-find-plugins', accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parse === 'text' ? await res.text() : await res.json()
}

async function load (url, { ttlMs, timeoutMs, parse, headers }) {
  const hit = store.get(url)
  const fresh = hit !== undefined && Date.now() - hit.at < ttlMs
  if (fresh) return { ok: true, value: hit.value, cached: true }

  if (inflight.has(url)) return inflight.get(url)

  const pending = (async () => {
    try {
      const value = await request(url, { timeoutMs, parse, headers })
      remember(url, value)
      return { ok: true, value, cached: false }
    } catch (error) {
      // Stale-if-error: better a slightly old answer, clearly labelled, than
      // a source that silently disappears from the result.
      if (hit !== undefined) return { ok: true, value: hit.value, cached: true, stale: true }
      return { ok: false, error: shortError(error) }
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, pending)
  return pending
}

export function fetchJson (url, options = {}) {
  return load(url, {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: 'json',
    headers: options.headers,
  })
}

export function fetchText (url, options = {}) {
  return load(url, {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: 'text',
    headers: options.headers,
  })
}

/** Test seam — and a way to force a refresh. */
export function clearCache () {
  store.clear()
  inflight.clear()
}

export function cacheSize () {
  return store.size
}
