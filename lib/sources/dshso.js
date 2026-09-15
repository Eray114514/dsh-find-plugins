/**
 * Source: dsh.so plugin index.
 *
 * The richest single source (~15k entries, ~9 MB): it carries verification
 * levels (L1–L5), a security scan result, repo health and download counts.
 * It is also the only source whose entries can be labelled `verified`.
 *
 * @module dsh-find-plugins/sources/dshso
 */

import { fetchJson } from '../cache.js'
import { entry, npmNameFromTarget, repoFromSpec, repoFromUrl, targetFromCommand } from '../merge.js'

export const id = 'dsh.so'
export const label = 'dsh.so'
export const url = 'https://www.dsh.so/plugins-index.json'

const TTL_MS = 30 * 60_000
const TIMEOUT_MS = 60_000

export async function load () {
  const res = await fetchJson(url, { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { ok: false, error: res.error, entries: [] }
  const plugins = Array.isArray(res.value?.plugins) ? res.value.plugins : []
  return { ok: true, stale: res.stale === true, entries: plugins.map(normalize).filter(Boolean) }
}

export function normalize (plugin) {
  if (plugin === null || typeof plugin !== 'object') return null
  const target = targetFromCommand(plugin.install)
  const repo = repoFromSpec(target) || repoFromUrl(plugin.url)
  if (repo === null) return null

  const riskLevel = plugin.security?.riskLevel
  const notes = []
  // dsh.so grades risk low/medium/high/critical — `critical` was observed in
  // the wild, so it must not fall through an if/else that only knows `high`.
  if (riskLevel === 'critical') notes.push('dsh.so 安全扫描标记为严重风险')
  else if (riskLevel === 'high') notes.push('dsh.so 安全扫描标记为高风险')
  else if (riskLevel === 'medium') notes.push('dsh.so 安全扫描标记为中风险')

  const topics = Array.isArray(plugin.topics) ? plugin.topics.filter((t) => typeof t === 'string') : []

  return entry({
    source: id,
    repo,
    description: plugin.description,
    stars: plugin.stars,
    npm: npmNameFromTarget(target),
    category: topics[0] ?? null,
    // ALL topics go into the searchable text, not just the first: topics are
    // the only English vocabulary a Chinese-described plugin may have, and
    // without them an English query cannot find it at all.
    topics,
    verification: plugin.verification
      ? { level: plugin.verification.level ?? null, label: plugin.verification.label ?? null }
      : null,
    security: plugin.security
      ? { status: plugin.security.status ?? null, riskLevel: riskLevel ?? null }
      : null,
    notes,
  })
}
