/**
 * Source: the dsh-plugin-radar catalog (PLUGINS.md).
 *
 * Radar is the only source that RUNS the plugins it lists — its rows carry a
 * run-level verdict, which is why it ranks just below dsh.so. The structured
 * `catalog/plugins/*.json` shards are deliberately NOT used: sampling them
 * showed most requests hang indefinitely, and a source that stalls the whole
 * tool call is worse than one that is simply absent.
 *
 * PLUGINS.md is a four-column markdown table:
 *   | 插件 | 仓库 | 说明 | 运行级 |
 *
 * @module dsh-find-plugins/sources/radar
 */

import { fetchText } from '../cache.js'
import { entry, repoFromUrl } from '../merge.js'

export const id = 'radar'
export const label = 'radar'
export const url = 'https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/PLUGINS.md'

const TTL_MS = 30 * 60_000
const TIMEOUT_MS = 25_000

export async function load () {
  const res = await fetchText(url, { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { ok: false, error: res.error, entries: [] }
  return { ok: true, stale: res.stale === true, entries: parseMarkdown(res.value) }
}

/** Markdown table → entries. Pure, so a fixture can pin the real format. */
export function parseMarkdown (text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    // Separator row (`|---|---|`) and the header row.
    if (/^[-: ]+$/.test(cells[1])) continue
    if (cells[0] === '插件' || cells[1] === '仓库') continue

    const repo = repoFromUrl(cells[1]) || repoFromUrl(/\((https?:\/\/[^)]+)\)/.exec(cells[1])?.[1] ?? '')
    if (repo === null) continue

    const rawDescription = cells[2] ?? ''
    const description = stripMarkdown(rawDescription)
    const runLevel = (cells[3] ?? '').trim()
    out.push(entry({
      source: id,
      repo,
      name: stripMarkdown(cells[0] ?? '') || undefined,
      description,
      // Radar sometimes names the npm package inside the prose as
      // ``npm `@scope/name` ``. Read it from the RAW cell — stripMarkdown
      // removes the backticks this pattern depends on.
      npm: npmMentionedIn(rawDescription),
      category: runLevel || null,
    }))
  }
  return out
}

/**
 * Strip only the markdown that a hand-written table cell must lose: link
 * syntax and code backticks. Emphasis markers (`*`, `_`) are deliberately
 * LEFT ALONE — in this ecosystem they are far more often part of a real
 * identifier than emphasis, and stripping them corrupts it
 * (`mcp__wps__*` → `mcpwps`). Cosmetic asterisks are a smaller cost than
 * silently mangling a tool name.
 */
export function stripMarkdown (text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `… npm \`@scope/name\`` → `@scope/name`. */
function npmMentionedIn (text) {
  const m = /npm\s+`([^`]+)`/i.exec(text)
  if (m === null) return null
  const candidate = m[1].trim()
  return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(candidate) ? candidate : null
}
