// M1 契约测试：工具注册、参数、输出渲染，以及最后返回行的 npm 校验。
//
// 全部离线：`globalThis.fetch` 在文件顶部被换成 fixtures 分派器，认不出的 URL
// 直接抛错——这样任何漏网的真实请求都会以测试失败的形式暴露，而不是悄悄联网
// （之前这个文件真的在打 dsh.so / GitHub，跑一次 26s）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { apply, renderText, name, inject } from '../lib/index.js'
import { verifyRow, verifyRows } from '../lib/npm-verify.js'
import { loadOne } from '../lib/sources/index.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readJson = (file) => JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'))
const readText = (file) => readFileSync(path.join(FIXTURES, file), 'utf8')

// ---------------------------------------------------------------------------
// Offline network
// ---------------------------------------------------------------------------

/** Flipped by the npm-only tests to control what the registry "says". */
const registry = {
  // Real pairs, so the guess-and-verify path is exercised against reality:
  // repo `dafei1288/dsh-hud` → package `dsh-hud`, whose manifest matches.
  'dsh-hud': {
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    repository: { type: 'git', url: 'git+https://github.com/dafei1288/dsh-hud.git' },
  },
  'dsh-omni-router': { version: '2.4.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
  'dsh-not-a-plugin': { version: '1.0.0' },
}

function json (value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  }
}

function text (value) {
  return { ok: true, status: 200, json: async () => JSON.parse(value), text: async () => value }
}

const CATALOGS = {
  'https://www.dsh.so/plugins-index.json': () => json(readJson('dshso.json')),
  'https://dsh.works/awesome-dsh-plugins/plugins.json': () => json(readJson('dshworks.json')),
  'https://awesome-dsh-plugin.com/plugins.json': () => json(readJson('awesome.json')),
  'https://dsh.lanshuagent.com/api/plugins': () => json(readJson('lanshu.json')),
  'https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/PLUGINS.md': () => text(readText('radar.md')),
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const target = String(url)
  const catalog = CATALOGS[target]
  if (catalog !== undefined) return catalog()

  if (target.startsWith('https://api.github.com/search/repositories?')) {
    // Page 1 of the singular topic carries the fixture; everything else (page 2,
    // the plural topic) comes back empty, which is also how the paging loop ends.
    const first = target.includes('page=1') && target.includes(encodeURIComponent('topic:dsh-plugin'))
    return json({ total_count: first ? 3 : 0, items: first ? readJson('github.json').items : [] })
  }

  if (target.startsWith('https://registry.npmjs.org/-/v1/search?')) return json(readJson('npm.json'))

  const latest = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/.exec(target)
  if (latest !== null) {
    const manifest = registry[decodeURIComponent(latest[1])]
    if (manifest === undefined) return json({ error: 'Not found' }, 404)
    return json(manifest)
  }

  throw new Error(`unexpected fetch in tests (offline suite): ${target}`)
}

after(() => { globalThis.fetch = realFetch })

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

function collect () {
  const registered = []
  const ctx = { tools: { register: (tool) => { registered.push(tool) } } }
  apply(ctx)
  return registered
}

test('导出插件元数据', () => {
  assert.equal(name, 'dsh-find-plugins')
  assert.deepEqual(inject, ['tools'])
})

test('apply 恰好注册一个工具', () => {
  const tools = collect()
  assert.equal(tools.length, 1)
})

test('工具名含 find + plugin 两个关键词（可发现性），且不与邻居完全同名', () => {
  const [tool] = collect()
  assert.equal(tool.name, 'find_dsh_plugins')
  // 找插件的插件，名字里得有 find 和 plugin —— 这是别人/模型第一反应会搜的词
  assert.match(tool.name, /find/)
  assert.match(tool.name, /plugin/)
  // 完全同名会真的让模型选不出来；差一个字符可以接受（A 已弃管，且本插件是它的替代品），
  // 但描述必须能一眼区分，所以下面单独断言描述里的差异点。
  assert.notEqual(tool.name, 'find_dsh_plugin')
  assert.notEqual(tool.name, 'plugin_search')
})

test('描述必须能把它和邻居区分开（名字相近时的兜底）', () => {
  const [tool] = collect()
  const d = tool.description
  // 邻居 A 只搜 GitHub 一个源、按 star 排；本插件的差异点是多目录聚合 + 信任加权
  assert.match(d, /several|multiple/i, '应点明是多目录聚合，而不是单源搜索')
  assert.match(d, /trust/i, '应点明按可信度排序，而不是按 star')
})

test('工具描述讲清了：何时用、比裸搜强在哪、语言提示', () => {
  const [tool] = collect()
  const d = tool.description
  assert.match(d, /DSH/i, '应说明是给 DSH 找插件')
  assert.match(d, /rank|relevance|trust|freshness/i, '应说明排序不是只看 star')
  assert.match(d, /catalog|registr/i, '应说明是多目录聚合')
  assert.match(d, /English/i, '应提到中英对照')
  assert.match(d, /third-party/i, '应提示插件是第三方代码')
})

test('工具描述鼓励多关键词，并说明更多词是放宽而不是收窄', () => {
  const [tool] = collect()
  const d = tool.description
  assert.match(d, /space-separated/i, '应说明可以空格分隔多个词')
  assert.match(d, /more terms/i, '应说明更多词通常更好')
  assert.match(d, /widen|not narrow/i, '应澄清更多词是放宽召回')
  assert.match(d, /ServerChan|PaddleOCR|Tesseract/i, '应举例说明"只有你知道的词"该加进来')
  assert.match(tool.parameters.properties.query.description, /space-separated/i, '参数说明也要讲多关键词')
})

test('query 必填，limit / includeUnvetted 可选', () => {
  const [tool] = collect()
  // defineTool 把参数规格规范化成 JSON Schema：properties + required 数组
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.query.type, 'string')
  assert.equal(tool.parameters.properties.limit.type, 'number')
  assert.equal(tool.parameters.properties.includeUnvetted.type, 'boolean')
  assert.deepEqual(tool.parameters.required, ['query'])
})

test('execute 返回契约完整的对象', async () => {
  const [tool] = collect()
  const out = await tool.execute({ query: 'memory' })
  assert.equal(out.query, 'memory')
  assert.equal(typeof out.poolSize, 'number')
  assert.equal(typeof out.matched, 'number')
  assert.ok(Array.isArray(out.results))
  assert.ok(out.sources && typeof out.sources === 'object')
})

test('execute：七个源都出现在状态里（含新增的 dsh.works 与 npm）', async () => {
  const [tool] = collect()
  const out = await tool.execute({ query: 'screenshot 截图' })
  for (const id of ['dsh.so', 'dsh.works', 'radar', 'lanshu', 'awesome', 'github', 'npm']) {
    assert.ok(out.sources[id] !== undefined, `源 ${id} 应报告状态`)
  }
  assert.ok(out.poolSize > 0)
})

test('execute：GitHub 话题两页（单复数）合并后不漏不重', async () => {
  const [tool] = collect()
  const out = await tool.execute({ query: 'memory' })
  assert.equal(out.sources.github.ok, true)
  assert.equal(out.sources.github.count, 3, 'fixture 里 3 条，复数话题为空')
})

test('limit 夹取：超上限截断，非法值回落默认', async () => {
  const [tool] = collect()
  assert.equal((await tool.execute({ query: 'x', limit: 999 })).limit, 20)
  assert.equal((await tool.execute({ query: 'x', limit: 5 })).limit, 5)
  assert.equal((await tool.execute({ query: 'x', limit: 0 })).limit, 8)
  assert.equal((await tool.execute({ query: 'x', limit: -3 })).limit, 8)
  assert.equal((await tool.execute({ query: 'x' })).limit, 8)
})

// Regression: the tool framework rejects any output that is not "lossless JSON",
// i.e. whose values cannot be stringified and parsed back without change.
// `undefined` in an object is silently dropped by JSON.stringify, which made
// the result objects fail the framework's validation with the cryptic message
// "value is not lossless JSON".
test('输出对象在 JSON.stringify/parse 之后完全相等（无 undefined 丢值）', async () => {
  const [tool] = collect()
  const out = await tool.execute({ query: 'memory' })
  // 1. 整对象必须是 lossless 的
  const roundTrip = JSON.parse(JSON.stringify(out))
  assert.deepEqual(roundTrip, out, 'JSON.stringify(out) 然后 parse 必须等于 out')
  // 2. 顶层的任何字段都不应该是 undefined（值是 undefined 会让 stringify 静默丢键）
  for (const [k, v] of Object.entries(out)) {
    assert.notEqual(v, undefined, `字段 ${k} 不应为 undefined`)
  }
  // 3. results 里每一项都该满足同样的条件
  for (const item of out.results) {
    for (const [k, v] of Object.entries(item)) {
      assert.notEqual(v, undefined, `results[].${k} 不应为 undefined`)
    }
    // score 字段要么存在且是对象，要么完全不存在（不能是 score: undefined）
    if ('score' in item) {
      assert.equal(typeof item.score, 'object')
    }
  }
})

test('非数字 limit 由运行时的 schema 校验拦下，不会进 execute', async () => {
  const [tool] = collect()
  await assert.rejects(
    () => tool.execute({ query: 'x', limit: 'abc' }),
    (err) => err.name === 'ToolArgsError',
  )
})

// ---------------------------------------------------------------------------
// 源预算
// ---------------------------------------------------------------------------

test('预算：源卡住时工具仍在预算内返回，该源报 timeout、其余源照常', async () => {
  const hung = { id: 'hang', label: 'hang', load: () => new Promise(() => {}) }
  const res = await Promise.all([
    loadOne(hung, undefined, 20),
    loadOne({ id: 'ok', label: 'ok', load: async () => ({ ok: true, entries: [1, 2] }) }, undefined, 20),
  ])
  assert.equal(res[0].ok, false)
  assert.equal(res[0].error, 'timeout')
  assert.equal(res[1].ok, true)
  assert.equal(res[1].entries.length, 2)
})

// ---------------------------------------------------------------------------
// 最终行的 npm 校验
// ---------------------------------------------------------------------------

test('npm 校验：仓库匹配且声明了 dsh → 安装目标升级成 npm 包并带上版本', async () => {
  // 真实一对：仓库 dafei1288/dsh-hud 对应 npm 包 dsh-hud（manifest 的 repository 与它一致）
  const item = {
    repo: 'dafei1288/dsh-hud', npm: null, npmVersion: null,
    sources: ['awesome'], evidence: 'curated', notes: [], topics: [],
  }
  const ok = await verifyRow(item)
  assert.equal(ok, true, 'manifest 声明了 dsh 且 repository 与条目一致')
  assert.equal(item.npm, 'dsh-hud')
  assert.equal(item.npmVersion, '0.1.0')
  assert.equal(item.npmVerified, true)
})

test('npm 校验：仓库对不上就不升级（同名包可能是别人的代码）', async () => {
  const item = { repo: 'someone/else', npm: null, npmVersion: null, sources: [], evidence: 'curated', notes: [], topics: [] }
  registry.else = { version: '9.9.9', dsh: { bundle: {} }, repository: { url: 'https://github.com/someone/other' } }
  const ok = await verifyRow(item)
  assert.equal(ok, false)
  assert.equal(item.npm, null, '仓库不匹配时不能把安装目标换成那个 npm 包')
})

test('npm 校验：没有 dsh 清单的包不算插件（关键字是自报的）', async () => {
  const item = { repo: null, npm: 'dsh-not-a-plugin', npmVersion: null, sources: ['npm'], evidence: 'indexed', notes: [], topics: [] }
  const ok = await verifyRow(item)
  assert.equal(ok, false)
  assert.equal(item.dropUnvetted, undefined, 'verifyRow 只判定，不负责剔除')
})

test('npm 校验：这行是 npm-only 且证明不了是插件 → 标记剔除并计数', async () => {
  const items = [
    { repo: null, npm: 'dsh-not-a-plugin', npmVersion: null, sources: ['npm'], evidence: 'indexed', notes: [], topics: [] },
    { repo: null, npm: 'dsh-omni-router', npmVersion: null, sources: ['npm'], evidence: 'indexed', notes: [], topics: [] },
  ]
  const { verified, dropped } = await verifyRows(items)
  assert.equal(verified, 1, 'dsh-omni-router 的 manifest 有 dsh')
  assert.equal(dropped, 1)
  assert.equal(items[0].dropUnvetted, true)
  assert.equal(items[1].dropUnvetted, undefined)
  assert.equal(items[1].npmVerified, true)
})

test('npm 校验：注册表不可达时不冒泡，行走原样', async () => {
  const item = { repo: 'unknown/unpublished', npm: null, npmVersion: null, sources: [], evidence: 'curated', notes: [], topics: [] }
  const ok = await verifyRow(item)
  assert.equal(ok, false)
  assert.equal(item.npm, null)
})

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('renderText 汇报每个源的状态（否则 agent 分不清"没有"和"查不到"）', () => {
  const text = renderText({
    sources: { radar: { ok: true }, 'dsh.so': { ok: true }, awesome: { ok: false, error: 'timeout' } },
    poolSize: 12639,
    matched: 37,
    results: [{
      repo: 'omdsh-dev/DSH-better-sidebar',
      stars: 3556,
      pushedAt: '2026-09-10',
      description: '开放的侧边栏底座',
      install: 'dsh plugin --profile web add dsh-better-sidebar',
      trust: 'radar + dsh.so · 验证 L3 · 安全 low',
    }],
  })
  assert.match(text, /3 个源/)
  assert.match(text, /radar ✓/)
  assert.match(text, /awesome ✗（timeout）/)
  assert.match(text, /候选池 12639 条/)
  assert.match(text, /1\. omdsh-dev\/DSH-better-sidebar/)
  assert.match(text, /装它：dsh plugin/)
  assert.match(text, /可信：/)
  assert.match(text, /第三方代码/, '结尾必须有通用风险提示')
})

test('renderText 汇报源自己的相关总量（模型要知道只读了一页）', () => {
  const text = renderText({
    sources: { github: { ok: true, label: 'GitHub topic', count: 100, total: 14915 } },
    poolSize: 1, matched: 1,
    results: [{ repo: 'a/b', stars: 1, install: 'x', trust: 'y' }],
  })
  assert.match(text, /GitHub topic ✓\(100 条 · 相关 14915\)/)
})

test('renderText 在零结果时给出可操作的下一步', () => {
  const text = renderText({ sources: { radar: { ok: true } }, poolSize: 10, matched: 0, results: [] })
  assert.match(text, /没有匹配/)
  assert.match(text, /换关键词/, '应引导换关键词重试')
  assert.match(text, /同义词/, '应提示加同义词')
  assert.match(text, /不是换个工具/, '应明确劝阻放弃/换工具')
})

test('renderText 给出正确的安装命令形式（dsh plugin add 强制要 --profile）', () => {
  const text = renderText({
    sources: { radar: { ok: true } },
    poolSize: 1,
    matched: 1,
    results: [{ repo: 'a/b', stars: 1, install: 'dsh-better-sidebar', trust: 'x' }],
  })
  assert.match(text, /dsh plugin --profile <你的 profile> add/, '命令形式必须带 --profile')
  assert.match(text, /重启/, '应说明装完要重启')
})

test('renderText 截断超长描述，避免撑爆输出', () => {
  const long = 'x'.repeat(500)
  const text = renderText({
    sources: { radar: { ok: true } },
    poolSize: 1,
    matched: 1,
    results: [{ repo: 'a/b', stars: 1, install: 't', description: long, trust: 'x' }],
  })
  const line = text.split('\n').find((l) => l.startsWith('   用途：'))
  assert.ok(line.length < 200, `描述行应被截断，实际 ${line.length} 字符`)
  assert.match(line, /…$/, '截断处应有省略号')
})

test('renderText 在命中多于返回时提示可以调大 limit', () => {
  const text = renderText({
    sources: { radar: { ok: true } },
    poolSize: 100, matched: 40,
    results: [{ repo: 'a/b', stars: 1, install: 't', trust: 'x' }],
  })
  assert.match(text, /还有 39 条命中未返回/)
  assert.match(text, /limit/)
})

test('renderText 在被地板过滤时如实汇报，而不是假装生态里没有', () => {
  const text = renderText({
    sources: { radar: { ok: true } },
    poolSize: 100, matched: 3, hiddenUnvetted: 12,
    results: [{ repo: 'a/b', stars: 1, install: 't', trust: 'x' }],
  })
  assert.match(text, /12 条证据不足/)
  assert.match(text, /includeUnvetted/)
})

test('renderText 给 npm-only 的条目一个能读的标题，而不是打印 null', () => {
  const text = renderText({
    sources: { npm: { ok: true, label: 'npm' } },
    poolSize: 1, matched: 1,
    results: [{ repo: null, npm: 'dsh-omni-router', stars: 0, install: 'dsh-omni-router', trust: 'npm · 已索引' }],
  })
  assert.match(text, /1\. npm 包：dsh-omni-router/)
  assert.ok(!text.includes('null'), '不该出现 null')
})

test('renderText 渲染 npm 版本与兼容性（这两条是装之前唯一能验证的线索）', () => {
  const text = renderText({
    sources: { 'dsh.works': { ok: true, label: 'dsh.works' } },
    poolSize: 1, matched: 1,
    results: [{
      repo: 'a/b', stars: 1, install: 'dsh-b', trust: 'x',
      npmVersion: '0.19.1', npmVerified: true,
      compat: { version: '0.1.5-rc.2', at: '2026-09-10' },
    }],
  })
  assert.match(text, /npm 版本：0\.19\.1（仓库已核对）/)
  assert.match(text, /兼容：核对于 dsh 0\.1\.5-rc\.2（2026-09-10）/)
})

test('renderText 不泄漏任何桌面壳概念（它必须对任何 DSH 用户成立）', () => {
  const text = renderText({
    sources: { radar: { ok: true } },
    poolSize: 1,
    matched: 1,
    results: [{ repo: 'a/b', stars: 1, install: 'x', trust: 'y' }],
  })
  for (const forbidden of ['桌面壳', 'desktop', '回滚', 'rollback', 'last-incident', 'dsh-desktop']) {
    assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `输出不应包含「${forbidden}」`)
  }
})