import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 排序维度必须处处一致。
 *
 * 这条守卫来自一次真实的漂移:rank.js 的公式是
 *   relevance * trust * freshness * popularity
 * 四个维度,但 package.json、README.en.md 和 GitHub 仓库 About 都只写了三个
 * (漏了 popularity),只有中文 README 是对的。dsh.so 直接抄了 GitHub About,
 * 于是它的注册表条目也少一个维度——而 awesome-dsh-plugin 明确要求「中英对等」
 * 且「描述会被与代码核对」。
 *
 * 所以:从 rank.js 的公式里**解析**出真实维度,再要求各处文案都提到它们。
 * 不是硬编码维度名——加了第五个维度而没改文案时,这条测试会失败。
 */
function rankingDimensions () {
  const src = read('lib/rank.js')
  const m = src.match(/final:\s*([a-zA-Z0-9_]+(?:\s*\*\s*[a-zA-Z0-9_]+)+)/)
  assert.ok(m, 'rank.js 里应能找到 final: a * b * c 形式的公式')
  return m[1].split('*').map((s) => s.trim()).filter(Boolean)
}

test('rank.js 的公式确实是四个维度', () => {
  assert.deepEqual(rankingDimensions(), ['relevance', 'trust', 'freshness', 'popularity'])
})

test('各处文案都提到了全部排序维度', () => {
  const dims = rankingDimensions()
  // 维度名 → 文案里可能出现的写法（英文标识 / 中文名）
  const ALIASES = {
    relevance: ['relevance', '相关度'],
    trust: ['trust', '可信度'],
    freshness: ['freshness', '新鲜度'],
    popularity: ['popularity', '热度'],
  }
  const targets = [
    ['package.json description', JSON.parse(read('package.json')).description],
    ['README.md 首段', read('README.md').split('---')[0]],
    ['README.en.md 首段', read('README.en.md').split('---')[0]],
  ]
  for (const [label, text] of targets) {
    for (const dim of dims) {
      const hit = (ALIASES[dim] || [dim]).some((alias) => text.includes(alias))
      assert.ok(hit, `${label} 里没有提到排序维度 "${dim}"——文案与 rank.js 的公式脱节了`)
    }
  }
})

test('中英 README 的首段维度一致（awesome 列表要求对等）', () => {
  const dims = rankingDimensions()
  const zh = read('README.md').split('---')[0]
  const en = read('README.en.md').split('---')[0]
  const zhCount = dims.filter((d) => zh.includes(d) || zh.includes({ relevance: '相关度', trust: '可信度', freshness: '新鲜度', popularity: '热度' }[d])).length
  const enCount = dims.filter((d) => en.includes(d)).length
  assert.equal(zhCount, dims.length, '中文 README 首段应覆盖全部维度')
  assert.equal(enCount, dims.length, '英文 README 首段应覆盖全部维度')
})
