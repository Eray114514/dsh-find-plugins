// 三个补丁的回归测试：npm 64 字符截断、宿主版本探测与对比、超 2 周降权提示。
//
// 全部离线：宿主探测指向本文件构造的 fixture 目录树，npm 只测 URL 构造
// （不发请求——400 那个 bug 就是"URL 构造错了"，断言在构造层才钉得住）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { searchUrl } from '../lib/sources/npm.js'
import { compareCompat, detectHostVersion } from '../lib/host-version.js'
import { freshnessScore, STALE_DAYS } from '../lib/rank.js'
import { renderText } from '../lib/index.js'

// ---------------------------------------------------------------------------
// npm：text 参数 2–64 字符（实测口径：解码后的字符数，与编码字节无关）
// ---------------------------------------------------------------------------

/** The qualifier costs 20 of npm's 64 characters. */
const QUALIFIER = ' keywords:dsh-plugin'
const text = (url) => decodeURIComponent(/text=([^&]*)/.exec(url)[1])

test('npm：长查询被截断到 64 字符以内（否则整个源 400）', () => {
  // 复现真实故障：两轮划词翻译查询都是 79–80 字符，npm 拒收 ERR_TEXT_LENGTH。
  const long = '划词翻译 select text translate highlight translation 桌面端 desktop'
  assert.ok(long.length + QUALIFIER.length > 64, '前提：这个查询确实超长')
  const url = searchUrl(long)
  const param = text(url)
  assert.ok(param.length <= 64, `text 应 ≤64 字符，实际 ${param.length}`)
  assert.ok(param.endsWith(QUALIFIER.trim()), '关键词限定必须保留，否则查的不是插件')
})

test('npm：44 字符以内的查询原样保留，不动用户的词', () => {
  const short = 'screenshot 截图'
  assert.equal(text(searchUrl(short)), short + QUALIFIER)
})

test('npm：截断在词边界切，不留半截词', () => {
  // 'x'.repeat(40) + ' terminal' 超预算；词边界回退应丢掉悬空的 'terminal'
  const query = `${'x'.repeat(40)} terminal extra words here`
  const param = text(searchUrl(query))
  assert.ok(param.length <= 64)
  assert.ok(!/\btermi$/.test(param), '不该在半个词处截断')
})

test('npm：截断不劈开代理对（否则 encodeURIComponent 直接抛异常）', () => {
  // emoji 是代理对：slice 可能留下孤立高代理，encodeURIComponent 对它 THROW
  const query = '🚀'.repeat(40) + ' tail'
  assert.doesNotThrow(() => searchUrl(query), 'URL 构造必须不抛')
  assert.ok(text(searchUrl(query)).length <= 64)
})

test('npm：恰好 64 字符不截断（边界上的 200 不能被误伤）', () => {
  const exact = 'x'.repeat(64 - QUALIFIER.length)
  assert.equal(text(searchUrl(exact)), exact + QUALIFIER)
  assert.equal(text(searchUrl(exact)).length, 64)
})

// ---------------------------------------------------------------------------
// 宿主版本探测：fixture 目录树，不读本机安装
// ---------------------------------------------------------------------------

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

function fixture (files) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-find-host-'))
  temps.push(root)
  for (const [rel, value] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return root
}

test('宿主探测：Electron resources 下的 runtime 清单（真机主路径）', () => {
  const root = fixture({
    'app.asar/dsh/package.json': { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.0-rc.2' },
  })
  assert.equal(detectHostVersion({ env: {}, resourcesPath: root, entry: undefined }), '0.2.0-rc.2')
})

test('宿主探测：ASAR 不可读时回落到磁盘上的 runtime.json（desktopVersion 字段）', () => {
  const root = fixture({
    'runtime/primary-runtime/runtime.json': { desktopVersion: '0.1.5-rc.1' },
  })
  assert.equal(detectHostVersion({ env: {}, resourcesPath: root, entry: undefined }), '0.1.5-rc.1')
})

test('宿主探测：只认声明了宿主包名的清单，不认野 manifest', () => {
  // 版本号能解析但包名不对 → 必须返回 null：错版本比没版本更糟，
  // 它会给每一条兼容行都打上错误标签。
  const root = fixture({
    'app.asar/dsh/package.json': { name: 'someone-else', version: '9.9.9' },
    'app.asar/package.json': { name: 'not-the-shell', version: '8.8.8' },
  })
  assert.equal(detectHostVersion({ env: {}, resourcesPath: root, entry: undefined }), null)
})

test('宿主探测：找不到就返回 null，不猜', () => {
  const root = fixture({})
  assert.equal(detectHostVersion({ env: {}, resourcesPath: root, entry: undefined }), null)
  assert.equal(detectHostVersion({ env: {}, resourcesPath: 'nope', entry: undefined }), null)
})

test('宿主探测：DSH_HOST_VERSION 覆盖优先，非法值拒绝', () => {
  assert.equal(
    detectHostVersion({ env: { DSH_HOST_VERSION: '0.3.0' }, resourcesPath: 'nope', entry: undefined }),
    '0.3.0',
  )
  assert.equal(
    detectHostVersion({ env: { DSH_HOST_VERSION: 'latest' }, resourcesPath: 'nope', entry: undefined }),
    null,
  )
})

test('宿主探测：CLI 入口在宿主包内部，向上走即命中', () => {
  // 真实布局：npm 全局装的 CLI，其入口脚本就在 @deepseek-ai/dsh 包里，
  // 走一层目录就到包根。
  const root = fixture({
    'lib/node_modules/@deepseek-ai/dsh/package.json': { name: '@deepseek-ai/dsh', version: '0.1.9' },
  })
  const entry = path.join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.js')
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(entry, '')
  assert.equal(detectHostVersion({ env: {}, resourcesPath: undefined, entry }), '0.1.9')
})

// ---------------------------------------------------------------------------
// 兼容行对比：cross / same-line / match / unknown
// ---------------------------------------------------------------------------

test('compareCompat：不同版本线 → cross（要提示的那种）', () => {
  assert.equal(compareCompat('0.1.0-rc.8', '0.2.0-rc.2'), 'cross')
  assert.equal(compareCompat('0.2.0-rc.2', '0.1.0-rc.8'), 'cross')
})

test('compareCompat：同线不同 rc → same-line（0.x 的破坏边界在 minor）', () => {
  assert.equal(compareCompat('0.2.0-rc.1', '0.2.0-rc.2'), 'same-line')
  // 回归：正则在预发布分隔符处停住，rc.1/rc.2 的 group 0 相同——
  // 按 group 0 比较会把它们误判成"完全一致"。
  assert.equal(compareCompat('0.2.0-rc.1', '0.2.0-rc.1'), 'match')
  assert.notEqual(compareCompat('0.2.0-rc.1', '0.2.0-rc.2'), 'match')
})

test('compareCompat：宿主未知或版本不可解析 → unknown（渲染层原样输出）', () => {
  assert.equal(compareCompat('0.1.0', null), 'unknown')
  assert.equal(compareCompat('0.1.0', undefined), 'unknown')
  assert.equal(compareCompat(null, '0.2.0'), 'unknown')
  assert.equal(compareCompat('not-a-version', '0.2.0'), 'unknown')
})

// ---------------------------------------------------------------------------
// 渲染：宿主行、跨版本警示、超 2 周未更新提示
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-06T00:00:00Z')

function sample (overrides = {}) {
  return {
    sources: { radar: { ok: true } },
    poolSize: 1, matched: 1,
    results: [{
      repo: 'a/b', stars: 1, pushedAt: '2026-10-01', description: 'x',
      install: 'dsh-b', trust: 'radar · 实测过',
      ...overrides,
    }],
  }
}

test('renderText：宿主版本打印在源状态之后，兼容行给出跨版本警示', () => {
  const out = renderText({
    ...sample({ compat: { version: '0.1.0-rc.8', at: '2026-08-20' } }),
    hostVersion: '0.2.0-rc.2',
  }, NOW)
  assert.match(out, /本次查询了 1 个源/)
  assert.match(out, /宿主：dsh 0\.2\.0-rc\.2/, '宿主行应紧跟源状态头')
  assert.match(out, /⚠ 与你的 dsh 0\.2\.0-rc\.2 不同版本线/)
  // 宿主行必须在任何兼容行之前出现，读者才能知道"你的版本"指什么
  assert.ok(out.indexOf('宿主：') < out.indexOf('兼容：'))
})

test('renderText：hostVersion 缺省时不打印宿主行，也不误标兼容', () => {
  const out = renderText(sample({ compat: { version: '0.1.0-rc.8', at: null } }), NOW)
  assert.ok(!out.includes('宿主：'), '未知宿主不该出现宿主行')
  assert.match(out, /兼容：核对于 dsh 0\.1\.0-rc\.8/, '兼容行原样保留')
  assert.ok(!out.includes('不同版本线'), '没有宿主就没有"不同版本线"的判断')
})

test('renderText：跨版本给 ⚠，同线与一致只做轻量标注', () => {
  const base = { ...sample(), hostVersion: '0.2.0-rc.2' }
  const cross = renderText({ ...base, results: [{ ...base.results[0], compat: { version: '0.1.0-rc.8', at: '2026-08-20' } }] }, NOW)
  assert.match(cross, /⚠ 与你的 dsh 0\.2\.0-rc\.2 不同版本线/)

  const same = renderText({ ...base, results: [{ ...base.results[0], compat: { version: '0.2.0-rc.1', at: '2026-09-01' } }] }, NOW)
  assert.match(same, /同线/)
  assert.ok(!same.includes('⚠'), '同线不该触发警示')

  const exact = renderText({ ...base, results: [{ ...base.results[0], compat: { version: '0.2.0-rc.2', at: '2026-09-20' } }] }, NOW)
  assert.match(exact, /与你的 dsh 0\.2\.0-rc\.2 一致/)
})

test('renderText：超过 2 周未更新给出提示并说明已降权', () => {
  const out = renderText(sample({ pushedAt: '2026-09-01' }), NOW) // 35 天
  assert.match(out, /已 35 天未更新（超过 2 周），排序已相应降权/)
})

test('renderText：2 周内不提示；日期未知不误报', () => {
  const fresh = renderText(sample({ pushedAt: '2026-10-01' }), NOW) // 5 天
  assert.ok(!fresh.includes('未更新'), '新鲜的不该被标')

  const unknown = renderText(sample({ pushedAt: null }), NOW)
  assert.ok(!unknown.includes('未更新'), '没有日期不是废弃的证据')
})

// ---------------------------------------------------------------------------
// 排序：超 2 周降权
// ---------------------------------------------------------------------------

test('freshness：阈值常量就是 14 天（渲染与排序共用）', () => {
  assert.equal(STALE_DAYS, 14)
})

test('freshness：超过 2 周被降权，2 周内满分', () => {
  const fresh = freshnessScore({ pushedAt: '2026-10-01T00:00:00Z' }, NOW) // 5 天
  const stale = freshnessScore({ pushedAt: '2026-09-01T00:00:00Z' }, NOW) // 35 天
  assert.equal(fresh, 1)
  assert.ok(stale < fresh, `超 2 周应降权：${stale} < ${fresh}`)
  assert.ok(Math.abs(stale - 0.85) < 1e-9, `降幅应为 15%，实际 ${stale}`)
})

test('freshness：降权是乘法——老插件之间仍按年龄拉开差距', () => {
  // 若阈值处是"跳档"，91 天和 365 天会挤在一起；乘法保证曲线不断。
  const d90 = freshnessScore({ pushedAt: new Date(NOW - 91 * 86_400_000).toISOString() }, NOW)
  const d365 = freshnessScore({ pushedAt: new Date(NOW - 365 * 86_400_000).toISOString() }, NOW)
  assert.ok(d90 > d365, `91 天(${d90}) 应高于 365 天(${d365})`)
})

test('freshness：未知日期仍给中性分，不受降权影响', () => {
  const unknown = freshnessScore({ pushedAt: null }, NOW)
  assert.equal(unknown, 0.85, '未知 ≠ 陈旧')
})

test('freshness：既有档位约束不被破坏（回归）', () => {
  const now = Date.parse('2026-09-13T00:00:00Z')
  assert.equal(freshnessScore({ pushedAt: '2026-09-01T00:00:00Z' }, now), 1)
  assert.ok(freshnessScore({ pushedAt: '2023-01-01T00:00:00Z' }, now) < 0.7)
  assert.ok(freshnessScore({ pushedAt: '2026-09-01T00:00:00Z', archived: true }, now) < 0.5)
})
