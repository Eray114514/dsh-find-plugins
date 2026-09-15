/**
 * Tokenizing and BM25.
 *
 * Zero dependencies on purpose: a CJK segmenter (jieba and friends) would be
 * a large runtime dependency for a plugin whose whole job is answering one
 * question, and bigrams get most of the way there.
 *
 * The CJK handling is the important part. Splitting a Chinese phrase into
 * whole whitespace runs — which is what the obvious implementation does, and
 * what a competing tool does — turns `跨会话记忆` into ONE token that only
 * matches a description containing that exact phrase. A description saying
 * `跨会话长期记忆` then does not match. Bigrams (`跨会/会话/话记/记忆`) match
 * both.
 *
 * @module dsh-find-plugins/text
 */

const K1 = 1.5
const B = 0.75

/** Split text into lowercase latin/numeric runs plus CJK bigrams. */
export function tokenize (text) {
  const lower = String(text ?? '').toLowerCase()
  const tokens = []
  for (const match of lower.matchAll(/[a-z0-9]+/g)) tokens.push(match[0])

  // Bigram each CJK RUN, not the concatenation of all of them. Stripping the
  // non-CJK characters first (the obvious implementation) glues separate
  // words together and manufactures junk tokens across the boundary:
  // `微信 通知` became `微信通知` → `信通` — a token that exists in neither
  // word and matches unrelated text.
  for (const run of lower.split(/[^\u4e00-\u9fff]+/)) {
    if (run === '') continue
    if (run.length === 1) tokens.push(run)
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
  }

  return tokens
}

/** Document frequency of every token across the corpus. */
export function documentFrequencies (docs) {
  const df = new Map()
  for (const tokens of docs) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return df
}

/** BM25 score of one document against one query. */
export function bm25 (queryTokens, docTokens, df, total, averageLength, length) {
  let score = 0
  for (const token of queryTokens) {
    const tf = docTokens.filter((t) => t === token).length
    if (tf === 0) continue
    const frequency = df.get(token) ?? 0
    const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
    score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / averageLength)))
  }
  return score
}

/**
 * Cross-language term pairs.
 *
 * Recall, not scoring: a plugin whose name is `dsh-TUI` and whose description
 * is Chinese is invisible to the query "terminal" — there is no shared token,
 * so it never reaches the ranker at all. GitHub's own search finds it because
 * it reads READMEs; we cannot afford to fetch READMEs for 14k entries, so the
 * cheap equivalent is to expand the QUERY with the terms the other language
 * would have used.
 *
 * Deliberately a short hand-curated list of things DSH plugins actually do,
 * not a translation service.
 */
const SYNONYM_PAIRS = [
  ['terminal', '终端'], ['tui', '终端'], ['memory', '记忆'], ['screenshot', '截图'],
  ['notification', '通知'], ['notify', '通知'], ['ocr', '文字识别'], ['translate', '翻译'],
  ['voice', '语音'], ['tts', '语音'], ['theme', '主题'], ['skin', '皮肤'],
  ['image', '图片'], ['search', '搜索'], ['sidebar', '侧边栏'], ['vision', '视觉'],
  ['context', '上下文'], ['model', '模型'], ['browser', '浏览器'], ['file', '文件'],
  ['session', '会话'], ['agent', '智能体'], ['task', '任务'], ['calendar', '日历'],
  ['wechat', '微信'], ['feishu', '飞书'], ['lark', '飞书'], ['proxy', '代理'],
  ['backup', '备份'], ['sync', '同步'], ['chart', '图表'], ['cost', '用量'],
  ['usage', '用量'], ['prompt', '提示词'], ['skill', '技能'], ['plugin', '插件'],
  ['email', '邮件'], ['mail', '邮件'], ['schedule', '定时'], ['cron', '定时'],
  ['push', '推送'], ['log', '日志'], ['monitor', '监控'], ['database', '数据库'],
  ['cli', '命令行'], ['docs', '文档'], ['download', '下载'], ['upload', '上传'],
  ['export', '导出'], ['import', '导入'], ['workflow', '工作流'], ['note', '笔记'],
  ['todo', '待办'], ['docker', '容器'], ['sms', '短信'], ['excel', '表格'],
]

const SYNONYMS = (() => {
  const map = new Map()
  for (const [en, zh] of SYNONYM_PAIRS) {
    if (!map.has(en)) map.set(en, new Set())
    if (!map.has(zh)) map.set(zh, new Set())
    map.get(en).add(zh)
    map.get(zh).add(en)
  }
  return map
})()

/**
 * The other number of a latin token, when there is an obvious one.
 *
 * Asked for `screenshots`, a bag-of-words search finds only documents that
 * literally wrote "screenshots": measured against the live pool the query
 * `screenshot` matched 92 entries and `screenshots` matched 26, and the two
 * result lists disagreed about the top five. Both directions are generated so
 * the pair collapses whichever way the caller wrote it.
 *
 * Deliberately conservative: short tokens are left alone (`ts`, `db`, `ui` are
 * usually identifiers, and `+s` noise there is worse than the recall), and
 * endings that LOOK plural but are not (`status`, `analysis`, `css`, `bus`,
 * `canvas`) are excluded — folding those would corrupt real identifiers.
 */
export function pluralVariants (token) {
  if (!/^[a-z0-9]{4,}$/.test(token)) return []
  if (/ies$/.test(token)) return [token.slice(0, -3) + 'y']
  if (/s$/.test(token)) return /(ss|us|is|as|os)$/.test(token) ? [] : [token.slice(0, -1)]
  if (/[^aeiou]y$/.test(token)) return [token.slice(0, -1) + 'ies']
  return [token + 's']
}

/**
 * Widen the query: plural/singular variants first, then the other-language
 * equivalent of every token that has one.
 *
 * Variants are generated BEFORE the synonym lookup on purpose — otherwise a
 * caller asking for `screenshots` would get no Chinese expansion at all,
 * because the synonym table is keyed by the singular `screenshot`.
 */
export function expandTokens (tokens) {
  const base = [...tokens]
  for (const token of tokens) {
    for (const variant of pluralVariants(token)) if (!base.includes(variant)) base.push(variant)
  }

  const out = [...base]
  for (const token of base) {
    const mapped = SYNONYMS.get(token)
    if (mapped === undefined) continue
    for (const term of mapped) {
      for (const extra of tokenize(term)) if (!out.includes(extra)) out.push(extra)
    }
  }
  return out
}

/**
 * Build the searchable text of one entry.
 *
 * Every field a source publishes about WHAT THE PLUGIN DOES goes in here, not
 * just the name. A plugin can be named `dsh-oc` or `seektty` and still be the
 * only OpenCode TUI frontend in the ecosystem — the description is where that
 * lives, and the npm name often carries vocabulary the repo name does not
 * (`@deepseek-harness-tui/dsh-tui`).
 *
 * The name is repeated so a name hit outweighs a description hit without
 * hand-rolling per-field scoring. Repeating it twice is a deliberate, bounded
 * amount — enough to dominate an incidental description match, not enough to
 * let a long description drown a name hit.
 *
 * NOT included, on purpose: risk notes, verification labels, licence, owner.
 * They describe how much to TRUST an entry, not what it does; putting them in
 * the searchable text would let a query like "review" or "license" match every
 * entry that merely has an opinion attached to it.
 */
export function documentText (item) {
  const parts = [
    item.name ?? '',
    item.name ?? '',
    item.repo ?? '',
    item.npm ?? '',
    item.description?.en ?? '',
    item.description?.zh ?? '',
    item.category ?? '',
    Array.isArray(item.topics) ? item.topics.join(' ') : '',
  ]
  return parts.join(' ')
}

/** An index over a corpus: per-document tokens plus the corpus statistics. */
export function buildIndex (items) {
  const docs = items.map((item) => tokenize(documentText(item)))
  const df = documentFrequencies(docs)
  const total = docs.length
  const averageLength = total === 0 ? 1 : docs.reduce((sum, tokens) => sum + tokens.length, 0) / total
  return { docs, df, total, averageLength }
}

/**
 * Raw relevance for one item, plus the explicit boosts BM25 cannot express.
 *
 * BM25 is bag-of-words: it cannot tell that the query IS the package name.
 * An exact name hit has to outrank a long description that merely mentions
 * the word, or `dsh-tui` gets buried under a plugin whose README lists
 * "terminal" five times.
 */
export function relevance (query, queryTokens, index, itemIndex, item) {
  const tokens = index.docs[itemIndex]
  const base = bm25(queryTokens, tokens, index.df, index.total, index.averageLength, tokens.length)

  const name = String(item.name ?? '').toLowerCase()
  const repo = String(item.repo ?? '').toLowerCase()

  // Modest on purpose. A large exact-name boost normalizes everything else
  // to near zero, which hands the ranking to whichever ★1 repo happens to be
  // named exactly after the query — measured, that put a ★1 repo above a
  // ★3k plugin. The boost should break ties between relevant entries, not
  // decide the ranking on its own.
  const boostFor = (needle) => {
    if (needle === '') return 0
    if (name === needle || repo === needle) return 4
    if (name.startsWith(needle)) return 2.5
    if (name.includes(needle)) return 1.5
    if (repo.includes(needle)) return 0.75
    return 0
  }

  // Score the WHOLE query and EVERY individual term, then take the best.
  // Only testing the whole query means the boost silently never fires for a
  // multi-term query — `terminal 终端` is not the name of anything, so a
  // plugin actually named `terminal` would get no boost at all. Terms shorter
  // than 2 characters are skipped: they match almost everything and would
  // turn the boost into noise.
  const needles = [String(query ?? '').trim().toLowerCase()]
  for (const token of queryTokens) if (token.length >= 2) needles.push(token)
  let boost = 0
  for (const needle of needles) boost = Math.max(boost, boostFor(needle))

  return base + boost
}

/** Score every item and return the indices, best first (raw relevance only). */
export function search (query, items) {
  const queryTokens = expandTokens(tokenize(query))
  const index = buildIndex(items)
  const scored = items.map((item, itemIndex) => ({
    item,
    itemIndex,
    score: relevance(query, queryTokens, index, itemIndex, item),
  }))
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)
}
