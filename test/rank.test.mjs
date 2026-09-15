// 文本层 + 排序层。这里最关键的是最后那个回归用例：
// 高 star 的通用框架不能压过真正对口的 DSH 插件——这正是 M3 存在的理由。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bm25, buildIndex, documentFrequencies, documentText, expandTokens, pluralVariants, relevance, search, tokenize } from '../lib/text.js'
import { freshnessScore, rank, trustScore } from '../lib/rank.js'
import { entry } from '../lib/merge.js'

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

test('tokenize：拉丁字母数字成词，中文切二字', () => {
  assert.deepEqual(tokenize('Hello World 42'), ['hello', 'world', '42'])
  assert.deepEqual(tokenize('跨会话记忆'), ['跨会', '会话', '话记', '记忆'])
  assert.deepEqual(tokenize('单个'), ['单个'])
  assert.deepEqual(tokenize('记'), ['记'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
})

test('tokenize：按空白分隔的中文词不会跨词切出垃圾 bigram', () => {
  // 先抹掉非中文字符再切二字（最直觉的写法）会把「微信 通知」粘成「微信通知」，
  // 从而造出「信通」—— 一个两个字里都不存在的 token。
  const tokens = tokenize('微信 通知')
  assert.deepEqual(tokens, ['微信', '通知'])
  assert.ok(!tokens.includes('信通'), '不该出现跨词边界的 token')
})

test('tokenize：中英混排各自成词', () => {
  assert.deepEqual(tokenize('terminal 终端'), ['terminal', '终端'])
  assert.deepEqual(tokenize('screenshot 截图'), ['screenshot', '截图'])
})

test('tokenize：中文整句不再是一个不可匹配的整块', () => {
  const tokens = tokenize('跨会话记忆')
  assert.ok(!tokens.includes('跨会话记忆'), '不该保留整串')
  assert.ok(tokens.includes('记忆'), '应切出二字片段')
})

test('中文二字切分能命中"跨会话长期记忆"这类近义表述', () => {
  const items = [{
    name: 'dsh-memory-evolve', repo: 'a/dsh-memory-evolve',
    description: { en: '', zh: '为 DSH 带来跨会话长期记忆能力' }, category: '',
  }]
  const hits = search('跨会话记忆', items)
  assert.equal(hits.length, 1, '整串匹配的实现会在这里返回 0')
})

// ---------------------------------------------------------------------------
// 复数折叠
// ---------------------------------------------------------------------------

test('pluralVariants：双向折叠，单复数都指向另一形态', () => {
  assert.deepEqual(pluralVariants('screenshots'), ['screenshot'])
  assert.deepEqual(pluralVariants('screenshot'), ['screenshots'])
  assert.deepEqual(pluralVariants('notifications'), ['notification'])
  assert.deepEqual(pluralVariants('plugins'), ['plugin'])
  assert.deepEqual(pluralVariants('queries'), ['query'])
  assert.deepEqual(pluralVariants('query'), ['queries'])
})

test('pluralVariants：看起来像复数但不是的词必须放过（否则毁掉真实标识符）', () => {
  for (const token of ['status', 'css', 'bus', 'analysis', 'canvas', 'plus']) {
    assert.deepEqual(pluralVariants(token), [], `${token} 不该被折叠`)
  }
  // 短词不动：ts / db / ui 这类更像标识符，加 s 的噪声比召回更贵
  assert.deepEqual(pluralVariants('ts'), [])
  assert.deepEqual(pluralVariants('ui'), [])
})

test('复数查询与单数查询命中同一批条目（实测 92 vs 26 的那种退化）', () => {
  const items = [
    { name: 'dsh-vision', repo: 'a/dsh-vision', description: { en: 'screenshot helper', zh: '' }, category: '' },
    { name: 'shots', repo: 'b/shots', description: { en: 'takes screenshots', zh: '' }, category: '' },
  ]
  const single = search('screenshot', items).map((hit) => hit.item.repo).sort()
  const plural = search('screenshots', items).map((hit) => hit.item.repo).sort()
  assert.equal(single.length, 2)
  assert.deepEqual(plural, single, '单数/复数必须可互换，而不是换出另一批候选')
})

test('复数变体也能吃到同义词（screenshots 要能命中中文"截图"）', () => {
  const items = [{
    name: 'dsh-shot', repo: 'a/dsh-shot',
    description: { en: '', zh: '给纯文本模型提供截图能力' }, category: '',
  }]
  assert.equal(search('screenshots', items).length, 1, '变体先于同义词展开：screenshots → screenshot → 截图')
})

test('expandTokens：变体与同义词都进查询词，且不重复', () => {
  const tokens = expandTokens(tokenize('screenshots'))
  assert.ok(tokens.includes('screenshot'))
  assert.ok(tokens.includes('截图'))
  assert.equal(new Set(tokens).size, tokens.length, '不该有重复 token')
})

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

test('documentFrequencies：按文档计，不按出现次数计', () => {
  const df = documentFrequencies([['a', 'a', 'b'], ['b']])
  assert.equal(df.get('a'), 1)
  assert.equal(df.get('b'), 2)
})

test('bm25：命中越多分越高，词越罕见权重越大', () => {
  const df = new Map([['common', 10], ['rare', 1]])
  const few = bm25(['rare'], ['rare'], df, 10, 5, 5)
  const many = bm25(['rare'], ['rare', 'rare', 'rare'], df, 10, 5, 5)
  assert.ok(many > few, 'tf 高应得分更高')
  const common = bm25(['common'], ['common'], df, 10, 5, 5)
  assert.ok(few > common, '罕见词 idf 更高')
})

test('bm25：不命中得 0', () => {
  assert.equal(bm25(['zzz'], ['aaa'], new Map(), 1, 1, 1), 0)
})

test('documentText：name 权重高于 description', () => {
  // repo 特意不含 name，避免把 repo 的出现次数算进来
  const text = documentText({ name: 'tui', repo: 'a/other', description: { en: 'x', zh: 'y' } })
  assert.equal((text.match(/tui/g) || []).length, 2, 'name 应出现两次')
})

test('documentText：描述（中英）与 npm 名都参与检索', () => {
  const item = {
    name: 'dsh-oc', repo: 'a/dsh-oc', npm: '@scope/opencode-tui',
    description: { en: 'OpenCode TUI frontend', zh: 'OpenCode 终端前端' },
    category: 'ui', topics: ['terminal'],
  }
  const text = documentText(item)
  assert.match(text, /OpenCode TUI frontend/, '英文描述要参与')
  assert.match(text, /OpenCode 终端前端/, '中文描述要参与')
  assert.match(text, /@scope\/opencode-tui/, 'npm 名要参与（仓库名可能不带这个词）')
  assert.match(text, /terminal/, 'topics 要参与')
})

test('documentText：风险/许可这类"可信度"字段不参与检索', () => {
  // 否则搜 "review" 或 "license" 会命中每一个只是附带了一条评语的条目
  const text = documentText({
    name: 'a', repo: 'x/a', description: { en: 'does a thing', zh: '' },
    category: null, topics: [], notes: ['目录审核：review'], license: 'MIT', owner: 'x',
  })
  assert.ok(!/review/i.test(text), '审查结论不该进检索文本')
  assert.ok(!/\bmit\b/i.test(text), '许可证不该进检索文本')
})

test('名字怪但描述说清用途的插件，靠描述也能被搜到', () => {
  const items = [{
    repo: 'chiro2001/dsh-oc', key: 'chiro2001/dsh-oc', name: 'dsh-oc',
    description: { en: 'OpenCode TUI frontend for DeepSeek Harness', zh: '以 OpenCode TUI 作为终端前端' },
    stars: 7, sources: ['dsh.so', 'lanshu'], evidence: 'verified', archived: false,
    pushedAt: null, notes: [], topics: [], category: null,
  }]
  const { results } = rank(items, 'opencode 终端前端', { limit: 5 })
  assert.equal(results.length, 1, '名字里没有 opencode/终端，但描述里有，就该命中')
})

test('relevance：名字精确命中必须压过长描述里的偶然提及', () => {
  const items = [
    { name: 'dsh-tui', repo: 'a/dsh-tui', description: { en: 'terminal ui', zh: '' }, category: '' },
    { name: 'big-thing', repo: 'b/big-thing', description: { en: 'terminal terminal terminal terminal', zh: '' }, category: '' },
  ]
  const index = buildIndex(items)
  const q = tokenize('dsh-tui')
  const named = relevance('dsh-tui', q, index, 0, items[0])
  const mentioned = relevance('dsh-tui', q, index, 1, items[1])
  assert.ok(named > mentioned, `名字命中(${named}) 应高于描述提及(${mentioned})`)
})

test('search：无命中返回空数组', () => {
  assert.deepEqual(search('zzzzz', [{ name: 'a', repo: 'a/a', description: { en: '', zh: '' } }]), [])
})

test('relevance：多关键词时，单个词命中名字也要吃到名字加权', () => {
  // 只拿整串 query 比名字的话，`terminal 终端` 不等于任何名字 → 加权永不触发，
  // 真正叫 terminal 的插件反而拿不到优势。
  const items = [
    { name: 'terminal', repo: 'a/terminal', description: { en: '', zh: '' }, category: '', topics: [] },
    { name: 'dsh-other', repo: 'b/dsh-other', description: { en: 'terminal 终端 stuff', zh: '' }, category: '', topics: [] },
  ]
  const index = buildIndex(items)
  const q = tokenize('terminal 终端')
  const named = relevance('terminal 终端', q, index, 0, items[0])
  const mentioned = relevance('terminal 终端', q, index, 1, items[1])
  assert.ok(named > mentioned, `名字命中(${named}) 应高于描述提及(${mentioned})`)
})

test('relevance：过短的词不参与名字加权，避免噪声', () => {
  const items = [{ name: 'ab-thing', repo: 'a/ab-thing', description: { en: '', zh: '' }, category: '', topics: [] }]
  const index = buildIndex(items)
  // 'ab' 只有 2 位 → 仍参与；'a' 1 位 → 不参与。用 1 位词验证不会凭空加满分
  const oneChar = relevance('z', tokenize('z'), index, 0, items[0])
  assert.equal(oneChar, 0, '不命中就该是 0，不该被短词加权救活')
})

test('多关键词比单关键词更能把对口插件顶上来', () => {
  const pool = [
    { repo: 'a/dsh-TUI', key: 'a/dsh-TUI', name: 'dsh-TUI', description: { en: 'full-screen terminal UI', zh: '全屏终端界面' }, stars: 2999, sources: ['awesome', 'lanshu'], evidence: 'curated', archived: false, pushedAt: null, notes: [], topics: [] },
    { repo: 'b/noise', key: 'b/noise', name: 'noise', description: { en: 'terminal terminal terminal', zh: '终端 终端 终端' }, stars: 50000, sources: ['github'], evidence: 'topic', archived: false, pushedAt: null, notes: [], topics: [] },
  ]
  const single = rank(pool, 'terminal', { limit: 2 })
  const multi = rank(pool, 'terminal 终端', { limit: 2 })
  assert.equal(multi.results[0].item.name, 'dsh-TUI', '多关键词应让对口插件排第一')
  assert.ok(
    multi.results[0].final > single.results[0].final || single.results[0].item.name === 'dsh-TUI',
    '多关键词不该让结果变差',
  )
})

// ---------------------------------------------------------------------------
// 信任
// ---------------------------------------------------------------------------

const plugin = (over = {}) => entry({
  source: 'dsh.so', repo: 'owner/name', stars: 100, ...over,
})

test('trust：多源互相印证会加分', () => {
  const one = trustScore({ ...plugin(), sources: ['dsh.so'] })
  const three = trustScore({ ...plugin(), sources: ['dsh.so', 'radar', 'lanshu'] })
  assert.ok(three > one)
})

test('trust：只有 dsh.so 单源（没有任何 DSH 专属目录认识它）会被打折', () => {
  const dshOnly = trustScore({ ...plugin(), sources: ['dsh.so'], evidence: 'verified' })
  const corroborated = trustScore({ ...plugin(), sources: ['dsh.so', 'awesome'], evidence: 'verified' })
  assert.ok(corroborated > dshOnly, '通用仓库只被 dsh.so 收录时不该和高可信条目同分')
})

test('trust：dsh.so 验证等级 >= 3 与 radar 实测过都加分', () => {
  const plain = trustScore({ ...plugin(), sources: ['dsh.so', 'awesome'] })
  const verified = trustScore({ ...plugin(), sources: ['dsh.so', 'awesome'], verification: { level: 4 } })
  const tested = trustScore({ ...plugin(), sources: ['dsh.so', 'awesome'], evidence: 'tested' })
  assert.ok(verified > plain)
  assert.ok(tested > plain)
})

test('trust：高风险与归档都扣分，且下限被夹住', () => {
  const safe = trustScore({ ...plugin(), sources: ['dsh.so', 'radar'], security: { riskLevel: 'low' } })
  const high = trustScore({ ...plugin(), sources: ['dsh.so', 'radar'], security: { riskLevel: 'high' } })
  const archived = trustScore({ ...plugin(), sources: ['dsh.so', 'radar'], archived: true })
  assert.ok(high < safe)
  assert.ok(archived < safe)
  assert.ok(trustScore({ ...plugin(), sources: ['github'], evidence: 'topic', archived: true, security: { riskLevel: 'high' } }) >= 0.25)
})

test('trust：critical 必须被扣到比 high 更狠（实测漏过这一档）', () => {
  const base = { ...plugin(), sources: ['dsh.so', 'radar'] }
  const low = trustScore({ ...base, security: { riskLevel: 'low' } })
  const high = trustScore({ ...base, security: { riskLevel: 'high' } })
  const critical = trustScore({ ...base, security: { riskLevel: 'critical' } })
  assert.ok(critical < high, `critical(${critical}) 应低于 high(${high})`)
  assert.ok(high < low)
})

test('trust：没见过的风险等级按"有风险"处理，不能当安全放行', () => {
  const base = { ...plugin(), sources: ['dsh.so', 'radar'] }
  const low = trustScore({ ...base, security: { riskLevel: 'low' } })
  const unknown = trustScore({ ...base, security: { riskLevel: 'catastrophic' } })
  assert.ok(unknown < low, '未知等级不该被当成 low')
})

test('风险扣分必须轻到只是破平局，不能埋掉一个好用的插件', () => {
  // 用户的明确偏好：激进。自动化风险评估不可信，装之前会自己读源码，
  // 所以"可能有风险"不该让插件掉队。上限设为 0.35，超过就是把信号当成了裁决。
  const base = { ...plugin(), sources: ['dsh.so', 'radar', 'awesome', 'lanshu'], evidence: 'tested' }
  const safe = trustScore({ ...base, security: { riskLevel: 'low' } })
  const critical = trustScore({ ...base, security: { riskLevel: 'critical' } })
  assert.ok(safe - critical <= 0.35, `critical 扣分过重：${(safe - critical).toFixed(2)}`)
})

test('风险不构成排除：高风险但对口的插件仍能排在一个平庸的安全插件前面', () => {
  const now = Date.parse('2026-09-15T00:00:00Z')
  const riskyButGood = {
    repo: 'a/dsh-ocr', key: 'a/dsh-ocr', name: 'dsh-ocr',
    description: { en: 'local OCR for DSH', zh: '' }, stars: 400, pushedAt: '2026-09-10T00:00:00Z',
    archived: false, sources: ['dsh.so', 'awesome', 'lanshu'], evidence: 'tested', notes: [], topics: [],
    verification: { level: 4 }, security: { riskLevel: 'critical' },
  }
  const safeButMeh = {
    repo: 'b/ocr-tool', key: 'b/ocr-tool', name: 'ocr-tool',
    description: { en: 'a thing', zh: '' }, stars: 5, pushedAt: '2026-09-10T00:00:00Z',
    archived: false, sources: ['github'], evidence: 'topic', notes: [], topics: [],
    verification: null, security: { riskLevel: 'low' },
  }
  const { results } = rank([riskyButGood, safeButMeh], 'ocr', { limit: 2, now })
  assert.equal(results[0].item.repo, 'a/dsh-ocr', '高风险不该把对口插件压到平庸插件下面')
})

test('trust：仅 GitHub 话题的条目被降权', () => {
  const topic = trustScore({ ...plugin(), sources: ['github'], evidence: 'topic' })
  const curated = trustScore({ ...plugin(), sources: ['github', 'awesome'], evidence: 'curated' })
  assert.ok(topic < curated)
})

test('trust：dsh.works 是 DSH 专属目录，它的条目不该被"没有目录认识"的折扣打中', () => {
  const worksOnly = trustScore({ ...plugin(), sources: ['dsh.works'], evidence: 'curated' })
  const genericOnly = trustScore({ ...plugin(), sources: ['dsh.so'], evidence: 'verified' })
  assert.ok(worksOnly > genericOnly, 'dsh.works 只收 DSH 插件，认出它就是 DSH 专属证据')
})

test('trust：npm 关键字是自报的，只有 npm 证据的条目必须被降权', () => {
  const npmOnly = trustScore({ ...plugin(), sources: ['npm'], evidence: 'indexed' })
  const curated = trustScore({ ...plugin(), sources: ['npm', 'awesome'], evidence: 'curated' })
  assert.ok(npmOnly < curated)
})

// ---------------------------------------------------------------------------
// 新鲜度
// ---------------------------------------------------------------------------

test('freshness：越新越高，未知给中性分而不是零', () => {
  const now = Date.parse('2026-09-13T00:00:00Z')
  assert.equal(freshnessScore({ pushedAt: '2026-09-01T00:00:00Z' }, now), 1)
  assert.ok(freshnessScore({ pushedAt: '2026-03-01T00:00:00Z' }, now) < 1)
  assert.ok(freshnessScore({ pushedAt: '2023-01-01T00:00:00Z' }, now) < 0.7)
  const unknown = freshnessScore({ pushedAt: null }, now)
  assert.ok(unknown > 0.5 && unknown < 1, `未知时间应中性，实际 ${unknown}`)
})

test('freshness：归档直接压到底', () => {
  assert.ok(freshnessScore({ pushedAt: '2026-09-01T00:00:00Z', archived: true }) < 0.5)
})

// ---------------------------------------------------------------------------
// 排序：M3 存在的理由
// ---------------------------------------------------------------------------

test('rank：多源印证的 DSH 插件必须压过高 star 的通用框架', () => {
  // 两条都是真实数据（见 2026-09-13 的调研记录）
  const general = {
    repo: 'ruvnet/ruflo', key: 'ruvnet/ruflo', name: 'ruflo', owner: 'ruvnet',
    description: { en: 'The original agent meta-harness. Deploy intelligent multi-player swarms and build conversational AI systems. Features adaptive memory, self-learning intelligence, RAG integration.', zh: '' },
    stars: 71521, pushedAt: null, archived: false, license: null, npm: null, category: null,
    verification: { level: 3, label: 'L3' }, security: { status: 'audited', riskLevel: 'medium' },
    notes: [], sources: ['dsh.so'], evidence: 'verified',
  }
  const realPlugin = {
    repo: 'omdsh-dev/dsh-memory-evolve', key: 'omdsh-dev/dsh-memory-evolve', name: 'dsh-memory-evolve', owner: 'omdsh-dev',
    description: { en: '', zh: '为 DeepSeek Harness 带来「跨会话长期记忆 + 后台自我进化」能力的纯插件实现' },
    stars: 300, pushedAt: '2026-08-14T08:03:45Z', archived: false, license: 'MIT', npm: null, category: 'memory',
    verification: { level: 3, label: 'L3' }, security: { status: 'audited', riskLevel: 'low' },
    notes: [], sources: ['radar', 'lanshu', 'awesome'], evidence: 'tested',
  }

  const { results } = rank([general, realPlugin], 'memory', { limit: 8, now: Date.parse('2026-09-13T00:00:00Z') })
  assert.equal(results.length, 2)
  assert.equal(results[0].item.repo, 'omdsh-dev/dsh-memory-evolve', '真插件应排第一，而不是 ★71521 的通用库')
  assert.ok(results[0].final > results[1].final)
})

test('rank：精确名字命中排到最前（治"名字偏见"的反面——名字对就该靠前）', () => {
  const items = [
    { repo: 'omdsh-dev/DSH-better-sidebar', key: 'a', name: 'DSH-better-sidebar', description: { en: 'sidebar', zh: '' }, stars: 3556, sources: ['awesome', 'lanshu'], evidence: 'curated', archived: false, pushedAt: null, notes: [] },
    { repo: 'x/dsh-tui', key: 'b', name: 'dsh-tui', description: { en: 'terminal ui', zh: '' }, stars: 2999, sources: ['awesome', 'lanshu'], evidence: 'curated', archived: false, pushedAt: null, notes: [] },
    { repo: 'y/noise', key: 'c', name: 'noise', description: { en: 'a sidebar for terminal users', zh: '' }, stars: 99999, sources: ['github'], evidence: 'topic', archived: false, pushedAt: null, notes: [] },
  ]
  const { results } = rank(items, 'sidebar', { limit: 3 })
  assert.equal(results[0].item.name, 'DSH-better-sidebar', '名字里就有 sidebar 的应第一，而不是 ★99999 的擦边仓库')
})

test('rank：matched 反映命中总数，不是返回条数', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    repo: `o/p${i}`, key: `o/p${i}`, name: `plugin-${i}`,
    description: { en: 'a plugin', zh: '' }, stars: 1,
    sources: ['awesome'], evidence: 'curated', archived: false, pushedAt: null, notes: [],
  }))
  const { results, matched } = rank(items, 'plugin', { limit: 5 })
  assert.equal(results.length, 5)
  assert.equal(matched, 20)
})

test('rank：零命中时返回空且 matched=0', () => {
  const { results, matched } = rank([{ repo: 'a/b', key: 'a/b', name: 'b', description: { en: 'x', zh: '' }, stars: 1, sources: [], notes: [] }], 'nothing-matches')
  assert.deepEqual(results, [])
  assert.equal(matched, 0)
})
