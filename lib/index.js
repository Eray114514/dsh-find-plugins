/**
 * dsh-find-plugins — find the RIGHT DSH plugin, not just a plugin.
 *
 * Registers a single model-facing tool, `find_dsh_plugins`, that aggregates
 * several community catalogs and ranks by relevance × trust × freshness
 * instead of stars alone.
 *
 * Design boundaries (deliberate — they are what makes this usable by ANY DSH
 * user, not just one desktop shell):
 *   - read-only: never installs, uninstalls, enables, or disables anything;
 *   - never writes to a profile or to cordis.patch.yml;
 *   - owns no index and ships no offline snapshot (stale data presented as
 *     current is worse than no data);
 *   - makes no model call of its own — the calling agent IS the model, so
 *     spending a second call to re-rank would be slower and dumber;
 *   - knows nothing about any desktop shell around dsh.
 *
 * @module dsh-find-plugins
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { installTarget, mergeEntries } from './merge.js'
import { rank } from './rank.js'
import { loadAll } from './sources/index.js'

export const name = 'dsh-find-plugins'
export const inject = ['tools']

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

/** One description longer than this is cut: some run to 400+ characters. */
const MAX_DESCRIPTION = 170

/** Generic, shell-agnostic advice appended to every answer. */
const FOOTER = [
  '安装：`dsh plugin --profile <你的 profile> add <上面每条"装它"的目标>`，装完需要重启 DSH 才生效。',
  '插件是第三方代码：装之前建议核一下源码并锁版本。',
].join('\n')

/** Cut on a word-ish boundary so a truncated description still reads. */
function truncate (text, max = MAX_DESCRIPTION) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/**
 * Render the result as text the model can quote straight back to the user.
 *
 * The source-status header is not decoration: without it the agent cannot
 * tell "the ecosystem has three of these" from "one catalog timed out", and
 * a single-source tool that hides that is worse than useless.
 */
export function renderText (result) {
  const lines = []

  const sources = Object.entries(result.sources || {})
  if (sources.length > 0) {
    const rendered = sources.map(([key, state]) => {
      const name = (state && state.label) || key
      if (state && state.ok === true) {
        const bits = [`${state.count ?? 0} 条`]
        if (state.stale === true) bits.push('缓存副本')
        return `${name} ✓(${bits.join(' · ')})`
      }
      const why = state && state.error ? `（${state.error}）` : '（不可用）'
      return `${name} ✗${why}`
    })
    lines.push(`本次查询了 ${sources.length} 个源：${rendered.join(' · ')}`)
  }

  const results = result.results || []
  lines.push(`候选池 ${result.poolSize ?? 0} 条，命中 ${result.matched ?? 0} 条，返回 ${results.length} 条。`)

  // Tell the model how to widen — otherwise "8 results" reads as "8 exist".
  if ((result.matched ?? 0) > results.length) {
    lines.push(`（还有 ${result.matched - results.length} 条命中未返回：需要更多就把 limit 调大，上限 ${MAX_LIMIT}。）`)
  }
  if ((result.hiddenUnvetted ?? 0) > 0) {
    lines.push(`（另有 ${result.hiddenUnvetted} 条只被 GitHub 话题收录、没有任何目录验证过，默认已隐藏；要一并看就传 includeUnvetted: true。）`)
  }

  if (results.length === 0) {
    lines.push('')
    lines.push('没有匹配的插件。**换关键词再试一次**——通常是换个说法而不是换个工具：')
    lines.push('加上同义词、中英都写、补上这个功能背后的服务名（例如微信推送 → serverchan / Server酱）。')
    lines.push('')
    lines.push(FOOTER)
    return lines.join('\n')
  }

  results.forEach((item, index) => {
    lines.push('')
    lines.push(`${index + 1}. ${item.repo}  ★${item.stars}  更新于 ${item.pushedAt || '未知'}`)
    if (item.description) lines.push(`   用途：${truncate(item.description)}`)
    lines.push(`   装它：${item.install}`)
    if (item.trust) lines.push(`   可信：${item.trust}`)
    if (item.risk) lines.push(`   风险：${item.risk}`)
  })

  lines.push('')
  lines.push(FOOTER)
  return lines.join('\n')
}

export function apply (ctx) {
  ctx.tools.register(defineTool({
    name: 'find_dsh_plugins',
    description:
      'Search the whole DSH (DeepSeek Harness) plugin ecosystem for a plugin that provides some capability. ' +
      'Aggregates several community catalogs — dsh.so (with verification levels and security scans), the ' +
      'dsh-plugin-radar catalog, awesome-dsh-plugin, and a live GitHub `dsh-plugin` topic search — then ranks ' +
      'by relevance × trust × freshness rather than stars alone, so a small purpose-built plugin is not buried ' +
      'under a large unrelated repository. Use it when the user wants a capability DSH does not currently have, ' +
      'or asks what plugins exist for something. Each result comes with an install-ready spec plus the evidence ' +
      'behind it (which catalogs know the plugin, its verification level, and any security flags).\n\n' +
      'QUERY: pass one or more space-separated terms — more terms is usually BETTER, not narrower. Mix languages ' +
      'and naming variants freely, e.g. `terminal 终端 tui`, `wechat notification 微信 通知`, `screenshot 截图`. ' +
      'A few dozen common English↔Chinese pairs are expanded automatically, but terms only YOU know are not: ' +
      'a service or product name behind the feature (ServerChan/Server酱 for WeChat push, PaddleOCR, Tesseract), ' +
      'a synonym the user did not say, or the Chinese word for an English request. Add them. If a query returns ' +
      'little, the fix is almost always another term rather than a different tool.\n\n' +
      'Plugins are third-party code: advise reviewing the source and pinning a version.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What the user needs, as one or more space-separated terms. Mix languages and variants freely — e.g. "terminal 终端 tui", "wechat notification 微信 通知", "screenshot 截图". More terms widens the search; it does not narrow it.',
      },
      limit: {
        type: 'number',
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
      includeUnvetted: {
        type: 'boolean',
        description: 'Include entries known only from the GitHub topic search (no catalog has vetted them). Default false.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute: async (args) => {
      return search({
        query: String(args.query ?? ''),
        limit: normalizeLimit(args.limit),
        includeUnvetted: args.includeUnvetted === true,
      })
    },
    timeoutMs: 20000,
  }))
}

/**
 * A non-positive or non-finite limit is a caller mistake, not a request for
 * zero rows — fall back to the default rather than returning nothing.
 */
function normalizeLimit (value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(raw), MAX_LIMIT)
}

/**
 * The search itself: load every source, merge into one list, rank it.
 */
async function search ({ query, limit, includeUnvetted }) {
  const { sources, entries } = await loadAll({ query, githubPages: limit > 8 ? 3 : 2 })
  const merged = mergeEntries(entries)

  // One ranking pass over everything, then split — rather than ranking twice
  // or filtering before ranking, either of which would make the reported
  // counts disagree with what was actually searched.
  const { results: allMatched } = rank(merged, query, { limit: merged.length })

  // Floor: an entry nobody has vetted AND nobody has starred is almost always
  // a stray repo that tagged the topic. It is excluded from the answer but
  // COUNTED, so the model can tell "the ecosystem has nothing" from "a floor
  // was applied" and lift it.
  const vetted = includeUnvetted
    ? allMatched
    : allMatched.filter((entry) => entry.item.evidence !== 'topic' || entry.item.stars > 0)

  return {
    query,
    limit,
    includeUnvetted,
    sources,
    poolSize: merged.length,
    matched: vetted.length,
    hiddenUnvetted: allMatched.length - vetted.length,
    results: vetted.slice(0, limit).map((entry) => toResult(entry.item, entry)),
  }
}

/** Present one ranked entry in the output contract. */
function toResult (item, scores) {
  const evidenceLabel = {
    verified: '已验证',
    tested: '实测过',
    curated: '已收录',
    indexed: '已索引',
    topic: '仅 GitHub 话题',
  }[item.evidence] || item.evidence

  const trust = [item.sources.join(' + '), evidenceLabel]
  if (item.verification?.label) trust.push(String(item.verification.label))
  if (item.security?.riskLevel) trust.push(`安全 ${item.security.riskLevel}`)

  const risk = []
  if (item.archived) risk.push('仓库已归档')
  for (const note of item.notes) risk.push(note)

  return {
    repo: item.repo,
    stars: item.stars,
    pushedAt: item.pushedAt ? item.pushedAt.slice(0, 10) : null,
    description: item.description.zh || item.description.en || '',
    install: installTarget(item),
    trust: trust.filter(Boolean).join(' · '),
    risk: risk.join('；'),
    // Kept for the agent (and for tests): why this ranked where it did.
    // Conditional spread so we never write `score: undefined` — that value is
    // SILENTLY DROPPED by JSON.stringify, which makes the round-trip unequal
    // and trips the tool framework's lossless-JSON validation.
    ...(scores !== undefined && {
      score: {
        relevance: round(scores.relevance),
        trust: round(scores.trust),
        freshness: round(scores.freshness),
        popularity: round(scores.popularity),
        final: round(scores.final),
      },
    }),
  }
}

const round = (value) => Math.round(value * 1000) / 1000
