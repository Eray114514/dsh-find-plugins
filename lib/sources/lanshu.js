/**
 * Source: the 岚叔 (lanshu) catalog.
 *
 * Smallest source (~560 entries) but by far the richest per entry: it carries
 * `archived`, `pushedAt`, `license`, `maintenance`, `screening`, `attention`
 * and a `curated` flag. Those are exactly the freshness and risk signals the
 * ranking needs, so its entries are worth as much as a much larger list.
 *
 * @module dsh-find-plugins/sources/lanshu
 */

import { fetchJson } from '../cache.js'
import { entry, npmNameFromTarget, repoFromUrl, targetFromCommand } from '../merge.js'

export const id = 'lanshu'
export const label = '岚叔目录'
export const url = 'https://dsh.lanshuagent.com/api/plugins'

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
  const repo = plugin.repo || repoFromUrl(plugin.url)
  if (typeof repo !== 'string' || !repo.includes('/')) return null

  const target = targetFromCommand(plugin.installCommand)
  const npm = npmNameFromTarget(target)

  // screening / attention are the catalog's own review verdicts, and both are
  // OBJECTS (`{state, risk, …}` and `{level, reasons[]}`) — stringifying them
  // yields "[object Object]", which is worse than saying nothing. Only
  // explicit problems become notes: `pending`/`unknown` is the common case and
  // would drown every real warning in noise.
  const notes = []
  const screeningState = plugin.screening?.state
  const screeningRisk = plugin.screening?.risk
  if (typeof screeningState === 'string' && !['pass', 'ok', 'pending'].includes(screeningState)) {
    notes.push(`目录审核：${screeningState}`)
  }
  if (typeof screeningRisk === 'string' && !['low', 'none', 'unknown'].includes(screeningRisk)) {
    notes.push(`目录审核风险：${screeningRisk}`)
  }
  const attentionLevel = plugin.attention?.level
  if (typeof attentionLevel === 'string' && attentionLevel !== 'clear') {
    const reasons = Array.isArray(plugin.attention?.reasons) ? plugin.attention.reasons.filter((r) => typeof r === 'string') : []
    notes.push(`目录关注：${attentionLevel}${reasons.length > 0 ? `（${reasons.join('；')}）` : ''}`)
  }
  if (typeof plugin.maintenance === 'string' && plugin.maintenance !== 'active') {
    notes.push(`维护状态：${plugin.maintenance}`)
  }
  if (plugin.archived === true) notes.push('仓库已归档')

  return entry({
    source: id,
    repo,
    description: plugin.description,
    stars: plugin.stars,
    pushedAt: plugin.pushedAt,
    archived: plugin.archived === true,
    license: plugin.license,
    npm,
    category: plugin.category || null,
    notes,
  })
}
