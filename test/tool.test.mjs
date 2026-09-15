// M1 契约测试：工具注册、参数、输出渲染。
// 不联网、不碰 profile —— 纯粹验证插件对外的接口长什么样。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, renderText, name, inject } from '../lib/index.js'

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
  assert.match(d, /several|multiple|catalogs/i, '应点明是多目录聚合，而不是单源搜索')
  assert.match(d, /trust/i, '应点明按可信度排序，而不是按 star')
})

test('工具描述讲清了：何时用、比裸搜强在哪、语言提示', () => {
  const [tool] = collect()
  const d = tool.description
  assert.match(d, /DSH/i, '应说明是给 DSH 找插件')
  assert.match(d, /rank|relevance|trust|freshness/i, '应说明排序不是只看 star')
  assert.match(d, /catalog/i, '应说明是多目录聚合')
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

test('limit 夹取：超上限截断，非法值回落默认', async () => {
  const [tool] = collect()
  assert.equal((await tool.execute({ query: 'x', limit: 999 })).limit, 20)
  assert.equal((await tool.execute({ query: 'x', limit: 5 })).limit, 5)
  assert.equal((await tool.execute({ query: 'x', limit: 0 })).limit, 8)
  assert.equal((await tool.execute({ query: 'x', limit: -3 })).limit, 8)
  assert.equal((await tool.execute({ query: 'x' })).limit, 8)
})

test('非数字 limit 由运行时的 schema 校验拦下，不会进 execute', async () => {
  const [tool] = collect()
  await assert.rejects(
    () => tool.execute({ query: 'x', limit: 'abc' }),
    (err) => err.name === 'ToolArgsError',
  )
})

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
  assert.match(text, /12 条只被 GitHub 话题收录/)
  assert.match(text, /includeUnvetted/)
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
