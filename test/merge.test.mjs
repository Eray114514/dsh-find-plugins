// 合并层：统一结构、去重、按"取每项最好值"合并证据与字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  betterDescription, entry, installTarget, latestStamp, mergeEntries,
  normalizeDescription, npmNameFromTarget, repoFromSpec, repoFromUrl, targetFromCommand,
} from '../lib/merge.js'

test('repoFromUrl：吃掉的是仓库名，不是 markdown 残留', () => {
  assert.equal(repoFromUrl('https://github.com/owner/name'), 'owner/name')
  assert.equal(repoFromUrl('https://github.com/owner/name.git'), 'owner/name')
  assert.equal(repoFromUrl('https://github.com/owner/name/tree/main'), 'owner/name')
  assert.equal(repoFromUrl('[owner/name](https://github.com/owner/name)'), 'owner/name')
  assert.equal(repoFromUrl('https://github.com/owner/name)'), 'owner/name')
  assert.equal(repoFromUrl('https://example.com/owner/name'), null)
  assert.equal(repoFromUrl(null), null)
})

test('repoFromSpec：github: / git+https / https 三种写法', () => {
  assert.equal(repoFromSpec('github:owner/name'), 'owner/name')
  assert.equal(repoFromSpec('github:owner/name#v1.2.3'), 'owner/name')
  assert.equal(repoFromSpec('git+https://github.com/owner/name.git'), 'owner/name')
  assert.equal(repoFromSpec('https://github.com/owner/name'), 'owner/name')
  assert.equal(repoFromSpec('@scope/pkg'), null)
  assert.equal(repoFromSpec('dsh-context'), null)
})

test('targetFromCommand：从各源自己的安装命令里只取目标', () => {
  assert.equal(targetFromCommand('dsh plugin --profile web add github:a/b'), 'github:a/b')
  assert.equal(targetFromCommand('dsh plugin --profile web add dsh-context'), 'dsh-context')
  assert.equal(targetFromCommand('dsh plugin add x@1.2.3'), 'x@1.2.3')
  assert.equal(targetFromCommand('no add here'), null)
  assert.equal(targetFromCommand(null), null)
})

test('npmNameFromTarget：git spec / 路径 / URL 都不是 npm 名', () => {
  assert.equal(npmNameFromTarget('dsh-context'), 'dsh-context')
  assert.equal(npmNameFromTarget('@scope/pkg'), '@scope/pkg')
  assert.equal(npmNameFromTarget('@scope/pkg@1.2.3'), '@scope/pkg')
  assert.equal(npmNameFromTarget('pkg@^1.0.0'), 'pkg')
  assert.equal(npmNameFromTarget('github:a/b'), null)
  assert.equal(npmNameFromTarget('https://x/y.tgz'), null)
  assert.equal(npmNameFromTarget('./local'), null)
  assert.equal(npmNameFromTarget(null), null)
})

test('npmNameFromTarget：整条安装命令不能被当成包名（实测漏进过输出）', () => {
  // awesome 的 install 字段有的就是整条命令；宽松实现会把它原样当包名返回，
  // 结果渲染出 `装它：dsh plugin --profile web add github:...`
  assert.equal(npmNameFromTarget('dsh plugin --profile web add github:hust-open-atom-club/oh-dsh'), null)
  assert.equal(npmNameFromTarget('dsh plugin --profile web add dsh-context'), 'dsh-context')
  assert.equal(npmNameFromTarget('dsh plugin add @scope/pkg'), '@scope/pkg')
})

test('npmNameFromTarget：含空格或非法字符的一律拒绝', () => {
  assert.equal(npmNameFromTarget('two words'), null)
  assert.equal(npmNameFromTarget('pkg && rm -rf /'), null)
  assert.equal(npmNameFromTarget('UPPER CASE'), null)
  assert.equal(npmNameFromTarget('-leading-dash'), null)
})

test('normalizeDescription：字符串与双语对象都归一', () => {
  assert.deepEqual(normalizeDescription('hi'), { en: 'hi', zh: '' })
  assert.deepEqual(normalizeDescription({ en: 'a', zh: 'b' }), { en: 'a', zh: 'b' })
  assert.deepEqual(normalizeDescription(null), { en: '', zh: '' })
  assert.deepEqual(normalizeDescription({ en: 123 }), { en: '', zh: '' })
})

test('betterDescription：双语胜过单语，长胜过短', () => {
  assert.deepEqual(
    betterDescription({ en: 'a', zh: '' }, { en: 'a', zh: '中' }),
    { en: 'a', zh: '中' },
  )
  assert.deepEqual(
    betterDescription({ en: 'short', zh: '' }, { en: 'a much longer description', zh: '' }),
    { en: 'a much longer description', zh: '' },
  )
})

test('latestStamp：取较新者，空值不覆盖有值', () => {
  assert.equal(latestStamp('2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z'), '2026-05-01T00:00:00Z')
  assert.equal(latestStamp(null, '2026-05-01T00:00:00Z'), '2026-05-01T00:00:00Z')
  assert.equal(latestStamp('2026-05-01T00:00:00Z', null), '2026-05-01T00:00:00Z')
  assert.equal(latestStamp(null, null), null)
})

test('entry：按源决定 evidence 等级', () => {
  assert.equal(entry({ source: 'dsh.so', repo: 'a/b' }).evidence, 'verified')
  assert.equal(entry({ source: 'radar', repo: 'a/b' }).evidence, 'tested')
  assert.equal(entry({ source: 'awesome', repo: 'a/b' }).evidence, 'curated')
  assert.equal(entry({ source: 'github', repo: 'a/b' }).evidence, 'topic')
})

test('mergeEntries：同一仓库合并为一个，证据取最强', () => {
  const merged = mergeEntries([
    entry({ source: 'github', repo: 'owner/name', stars: 5, pushedAt: '2026-01-01T00:00:00Z' }),
    entry({ source: 'dsh.so', repo: 'owner/name', stars: 42, pushedAt: '2026-06-01T00:00:00Z' }),
    entry({ source: 'awesome', repo: 'OWNER/NAME', npm: '@scope/pkg' }),
  ])
  assert.equal(merged.length, 1, '大小写不同也算同一个仓库')
  const item = merged[0]
  assert.deepEqual(item.sources.sort(), ['awesome', 'dsh.so', 'github'])
  assert.equal(item.evidence, 'verified', '取最强证据等级')
  assert.equal(item.stars, 42, '取最大 star')
  assert.equal(item.pushedAt, '2026-06-01T00:00:00Z', '取最新时间')
  assert.equal(item.npm, '@scope/pkg', '缺的字段由别的源补上')
})

test('mergeEntries：archived 只要有一个源说是，就是', () => {
  const merged = mergeEntries([
    entry({ source: 'lanshu', repo: 'a/b', archived: true }),
    entry({ source: 'github', repo: 'a/b', archived: false }),
  ])
  assert.equal(merged[0].archived, true)
})

test('mergeEntries：notes 去重合并，verification / security 补齐', () => {
  const merged = mergeEntries([
    entry({ source: 'github', repo: 'a/b', notes: ['n1'] }),
    entry({ source: 'dsh.so', repo: 'a/b', notes: ['n1', 'n2'], verification: { level: 3, label: 'L3' }, security: { riskLevel: 'low' } }),
  ])
  assert.deepEqual(merged[0].notes.sort(), ['n1', 'n2'])
  assert.equal(merged[0].verification.level, 3)
  assert.equal(merged[0].security.riskLevel, 'low')
})

test('mergeEntries：没有仓库名的条目被丢弃', () => {
  assert.deepEqual(mergeEntries([null, undefined, { repo: null, key: null }]), [])
})

test('installTarget：npm 名优先于 github spec，且不带 profile 名', () => {
  assert.equal(installTarget({ npm: 'dsh-context', repo: 'a/b' }), 'dsh-context')
  assert.equal(installTarget({ npm: null, repo: 'a/b' }), 'github:a/b')
  assert.equal(installTarget({ npm: null, repo: null }), null)
  const target = installTarget({ npm: null, repo: 'a/b' })
  assert.ok(!target.includes('--profile'), '不该把 profile 名写进目标里')
})
