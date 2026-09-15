/**
 * npm manifest verification for the rows that are actually returned.
 *
 * Two things can only be settled by reading a package's manifest, and both
 * matter for the one line of output that has consequences — the install target:
 *
 *   1. A `github:` install runs no build step. When a repository does not
 *      commit its compiled output, that install produces a plugin with no code
 *      — and no pnpm flag fixes it, because the files are simply not there.
 *      The npm tarball is built from the same source by the author with their
 *      own prepublish step. Measured: a third of the sampled entries with no
 *      published npm name do in fact have one, with a matching repository.
 *   2. A package found through npm's `dsh-plugin` keyword proves nothing on its
 *      own — the keyword is self-declared. A manifest declaring `dsh` is what
 *      makes it a DSH plugin, and for an entry with no repository that field is
 *      the ONLY evidence available.
 *
 * Scope is deliberately the returned rows (≤ 20), not the pool: one request per
 * row, cached, bounded concurrency, and a total budget. A row that misses the
 * budget keeps the target its catalogs published — verification is an upgrade,
 * never a prerequisite.
 *
 * @module dsh-find-plugins/npm-verify
 */

import { fetchJson } from './cache.js'
import { repoFromUrl } from './merge.js'

const TTL_MS = 30 * 60_000
const TIMEOUT_MS = 4_000
const DEFAULT_CONCURRENCY = 5
const DEFAULT_BUDGET_MS = 6_000

/** The package name worth asking the registry about, or null. */
export function guessNpmName (item) {
  if (typeof item.npm === 'string' && item.npm !== '') return item.npm
  if (typeof item.repo !== 'string' || !item.repo.includes('/')) return null
  // Only the unscoped spelling can be guessed from a repository name; guessing
  // a scope would be inventing a package that may belong to someone else.
  const name = item.repo.split('/')[1]
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : null
}

/** `repository` is a string in some manifests and `{ url }` in others. */
function repositoryOf (manifest) {
  const value = manifest?.repository
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.url === 'string') return value.url
  return null
}

/**
 * Apply what the registry says to one row, in place.
 *
 * @returns {Promise<boolean>} whether the package is a verified DSH plugin.
 */
export async function verifyRow (item, { timeoutMs = TIMEOUT_MS } = {}) {
  const name = guessNpmName(item)
  if (name === null) return false

  const res = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    ttlMs: TTL_MS,
    timeoutMs,
  })
  if (!res.ok) return false

  const manifest = res.value
  // The one field that says "this is a DSH plugin" rather than "some package".
  if (!manifest?.dsh) return false

  // A repository-backed row must have the manifest's repository AGREE with it:
  // otherwise the package merely shares a name, and installing it would install
  // somebody else's code under this plugin's description.
  if (item.repo !== null) {
    const manifestRepo = repoFromUrl(repositoryOf(manifest))
    if (manifestRepo === null || manifestRepo.toLowerCase() !== item.repo.toLowerCase()) return false
  }

  item.npm = name
  if (typeof manifest.version === 'string' && item.npmVersion === null) item.npmVersion = manifest.version
  item.npmVerified = true
  return true
}

/**
 * Verify every returned row, bounded and never fatal.
 *
 * Rows that are npm-only (no repository) and cannot be verified are marked for
 * removal: with no catalog and no manifest evidence there is nothing left
 * saying the package is a plugin at all.
 *
 * @returns {Promise<{verified: number, dropped: number}>}
 */
export async function verifyRows (items, {
  concurrency = DEFAULT_CONCURRENCY,
  budgetMs = DEFAULT_BUDGET_MS,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const queue = [...items]
  let verified = 0
  let dropped = 0

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      let ok = false
      try {
        ok = await verifyRow(item, { timeoutMs })
      } catch {
        ok = false
      }
      if (ok) verified += 1
      else if (item.repo === null) {
        item.dropUnvetted = true
        dropped += 1
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  )
  let timer
  await Promise.race([
    Promise.all(workers),
    // Not unref'd: this timer is what settles the call when the registry is
    // slow, so it has to be able to fire on its own.
    new Promise((resolve) => { timer = setTimeout(resolve, budgetMs) }),
  ])
  clearTimeout(timer)

  return { verified, dropped }
}