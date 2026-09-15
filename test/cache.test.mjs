// 缓存与降级：TTL、单飞去重、超时、HTTP 错误、过期可用（stale-if-error）。
// 用 mock 的 globalThis.fetch，不联网。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { clearCache, fetchJson, fetchText, shortError } from '../lib/cache.js'
import { loadOne } from '../lib/sources/index.js'

const realFetch = globalThis.fetch
beforeEach(() => clearCache())

function mockFetch (impl) {
  globalThis.fetch = impl
}

function jsonResponse (value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => JSON.stringify(value) }
}

test('shortError：把底层错误收敛成短标签', () => {
  assert.equal(shortError(new Error('The operation was aborted due to timeout')), 'timeout')
  assert.equal(shortError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(shortError(new Error('getaddrinfo ENOTFOUND host')), 'dns')
  assert.equal(shortError(new Error('ECONNREFUSED 127.0.0.1')), 'connection')
  assert.equal(shortError(null), 'unknown error')
  assert.ok(shortError(new Error('x'.repeat(200))).length <= 61)
})

test('TTL 内第二次调用命中缓存，不再发请求', async () => {
  let calls = 0
  mockFetch(async () => { calls += 1; return jsonResponse({ n: calls }) })
  const a = await fetchJson('https://example.test/a', { ttlMs: 60_000 })
  const b = await fetchJson('https://example.test/a', { ttlMs: 60_000 })
  assert.equal(calls, 1, '只应请求一次')
  assert.equal(a.value.n, 1)
  assert.equal(b.cached, true)
})

test('并发调用同一 URL 只发一次请求（单飞去重）', async () => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 20))
    return jsonResponse({ n: calls })
  })
  const [a, b, c] = await Promise.all([
    fetchJson('https://example.test/b', { ttlMs: 60_000 }),
    fetchJson('https://example.test/b', { ttlMs: 60_000 }),
    fetchJson('https://example.test/b', { ttlMs: 60_000 }),
  ])
  assert.equal(calls, 1)
  assert.equal(a.value.n, 1)
  assert.equal(b.value.n, 1)
  assert.equal(c.value.n, 1)
})

test('HTTP 非 2xx 报成 HTTP <code>', async () => {
  mockFetch(async () => jsonResponse({}, 403))
  const res = await fetchJson('https://example.test/c', { ttlMs: 60_000 })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'HTTP 403')
})

test('网络异常被收敛，不把原始堆栈丢给模型', async () => {
  mockFetch(async () => { throw new Error('getaddrinfo ENOTFOUND nope') })
  const res = await fetchJson('https://example.test/d', { ttlMs: 60_000 })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'dns')
})

test('过期后请求失败 → 返回旧值并标记 stale（好过没有答案）', async () => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    if (calls === 1) return jsonResponse({ good: true })
    throw new Error('ECONNREFUSED')
  })
  const first = await fetchJson('https://example.test/e', { ttlMs: 1 })
  assert.equal(first.ok, true)
  assert.ok(!first.stale)

  await new Promise((r) => setTimeout(r, 10))
  const second = await fetchJson('https://example.test/e', { ttlMs: 1 })
  assert.equal(second.ok, true, '过期失败时应回落旧值')
  assert.equal(second.stale, true)
  assert.deepEqual(second.value, { good: true })
})

test('从未成功过则不会凭空造出旧值', async () => {
  mockFetch(async () => { throw new Error('ECONNREFUSED') })
  const res = await fetchJson('https://example.test/f', { ttlMs: 60_000 })
  assert.equal(res.ok, false)
})

test('fetchText 走同一套缓存逻辑', async () => {
  let calls = 0
  mockFetch(async () => { calls += 1; return { ok: true, status: 200, text: async () => '# hello' } })
  const a = await fetchText('https://example.test/g', { ttlMs: 60_000 })
  const b = await fetchText('https://example.test/g', { ttlMs: 60_000 })
  assert.equal(a.value, '# hello')
  assert.equal(calls, 1)
})

test('loadOne：源抛异常被转成状态，不冒泡', async () => {
  const res = await loadOne({ id: 'boom', load: async () => { throw new Error('getaddrinfo ENOTFOUND x') } })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'dns')
  assert.deepEqual(res.entries, [])
})

test('loadOne：源自己报告失败也原样传递', async () => {
  const res = await loadOne({ id: 'slow', load: async () => ({ ok: false, error: 'timeout', entries: [] }) })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'timeout')
})

test('loadOne：源返回垃圾形状时不崩，只当空', async () => {
  const res = await loadOne({ id: 'weird', load: async () => ({ ok: true, entries: null }) })
  assert.equal(res.ok, true)
  assert.deepEqual(res.entries, [])
})

test('loadOne：成功的源保留 stale 与 entries', async () => {
  const res = await loadOne({ id: 'ok', load: async () => ({ ok: true, stale: true, entries: [{ a: 1 }] }) })
  assert.equal(res.ok, true)
  assert.equal(res.stale, true)
  assert.equal(res.entries.length, 1)
})

// 恢复真实 fetch，避免影响其它测试文件（同进程运行时）
test.after?.(() => { globalThis.fetch = realFetch })
