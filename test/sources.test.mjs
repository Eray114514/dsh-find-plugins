// 每个源一份真实样本，验证解析器对着真实格式能产出统一结构。
// 只调 normalize / parseMarkdown（纯函数），不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import * as dshso from '../lib/sources/dshso.js'
import * as awesome from '../lib/sources/awesome.js'
import * as lanshu from '../lib/sources/lanshu.js'
import * as github from '../lib/sources/github.js'
import { parseMarkdown } from '../lib/sources/radar.js'
import { EVIDENCE_RANK } from '../lib/merge.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'))

/** Every normalized entry must satisfy the shared contract. */
function assertShape (item, { source, evidence }) {
  assert.equal(typeof item.key, 'string', 'key')
  assert.match(item.repo, /^[^/\s]+\/[^/\s]+$/, `repo 必须是 owner/name，实际 ${item.repo}`)
  assert.equal(item.key, item.repo.toLowerCase())
  assert.deepEqual(item.sources, [source])
  assert.equal(item.evidence, evidence)
  assert.equal(typeof item.description.en, 'string')
  assert.equal(typeof item.description.zh, 'string')
  assert.equal(typeof item.stars, 'number')
  assert.ok(Array.isArray(item.notes))
  assert.ok(EVIDENCE_RANK[item.evidence] > 0)
}

test('dsh.so：install 命令里的 github spec 解析成仓库', () => {
  const items = read('dshso.json').plugins.map(dshso.normalize)
  assert.ok(items.length > 0)
  for (const item of items) assertShape(item, { source: 'dsh.so', evidence: 'verified' })
  const first = items[0]
  assert.equal(first.repo, 'titanwings/colleague-skill')
  assert.equal(first.npm, null, 'github: spec 不是 npm 包名')
  assert.ok(first.verification && typeof first.verification.level === 'number')
  assert.ok(first.security && typeof first.security.riskLevel === 'string')
})

test('dsh.so：高风险条目会带上 note', () => {
  const high = dshso.normalize({
    install: 'dsh plugin --profile web add github:a/b',
    stars: 1,
    security: { status: 'audited', riskLevel: 'high' },
  })
  assert.match(high.notes.join(' '), /高风险/)
})

test('dsh.so：critical 也要带 note（实测这一档曾被漏掉）', () => {
  const critical = dshso.normalize({
    install: 'dsh plugin --profile web add github:a/b',
    stars: 1,
    security: { status: 'audited', riskLevel: 'critical' },
  })
  assert.match(critical.notes.join(' '), /严重风险/)
})

test('awesome：双语描述与 npm 字段', () => {
  const items = read('awesome.json').plugins.map(awesome.normalize)
  assert.ok(items.length > 0)
  for (const item of items) assertShape(item, { source: 'awesome', evidence: 'curated' })
  const first = items[0]
  assert.equal(first.repo, 'bycall/dsh-answer-reviewer')
  assert.ok(first.description.en.length > 0, '英文描述应存在')
  assert.ok(first.description.zh.length > 0, '中文描述应存在')
})

test('lanshu：archived / license / pushedAt 被保留', () => {
  const items = read('lanshu.json').plugins.map(lanshu.normalize)
  assert.ok(items.length > 0)
  for (const item of items) assertShape(item, { source: 'lanshu', evidence: 'curated' })
  const first = items[0]
  assert.equal(first.repo, 'huiliyi37/dsh-tianshu-tui')
  assert.equal(first.license, 'Apache-2.0')
  assert.match(first.pushedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('lanshu：screening / attention 是对象，不能变成 [object Object]', () => {
  // 真实形状：screening={state,risk,...} attention={level,reasons[]}
  const clean = lanshu.normalize({
    repo: 'a/b', stars: 1, maintenance: 'active',
    screening: { version: 1, state: 'pending', risk: 'unknown' },
    attention: { level: 'clear', reasons: [] },
  })
  assert.ok(!clean.notes.join(' ').includes('[object'), '不能把对象直接塞进字符串')
  assert.deepEqual(clean.notes, [], 'pending/unknown/clear 属于常态，不该产生噪音')

  const flagged = lanshu.normalize({
    repo: 'a/b', stars: 1, maintenance: 'stale',
    screening: { state: 'fail', risk: 'high' },
    attention: { level: 'warn', reasons: ['长期未更新', '无许可证'] },
  })
  const joined = flagged.notes.join(' | ')
  assert.match(joined, /目录审核：fail/)
  assert.match(joined, /目录审核风险：high/)
  assert.match(joined, /目录关注：warn（长期未更新；无许可证）/)
  assert.match(joined, /维护状态：stale/)
})

test('github：保留 GitHub 顺序，不按 star 重排；取非 dsh-plugin 的 topic 作分类', () => {
  const items = read('github.json').items.map(github.normalize)
  assert.equal(items.length, 3)
  for (const item of items) assertShape(item, { source: 'github', evidence: 'topic' })
  const first = items[0]
  assert.equal(first.repo, 'plastic-labs/honcho')
  assert.equal(first.license, 'AGPL-3.0')
  assert.equal(first.category, 'agent-memory', '应跳过 dsh-plugin 这个 topic')
})

test('github：NOASSERTION 的 license 视作未知', () => {
  const item = github.normalize({ full_name: 'a/b', license: { spdx_id: 'NOASSERTION' }, topics: [] })
  assert.equal(item.license, null)
})

test('radar：四列表格解析，仓库名不带 markdown 残留', () => {
  const items = parseMarkdown(readFileSync(path.join(FIXTURES, 'radar.md'), 'utf8'))
  assert.ok(items.length >= 5, `应解析出多行，实际 ${items.length}`)
  for (const item of items) {
    assertShape(item, { source: 'radar', evidence: 'tested' })
    assert.ok(!/[)\]`*]/.test(item.repo), `仓库名不该含 markdown 残留：${item.repo}`)
    // 说明列中英文都有，按语言归到对应槽位；至少得有一个槽位有内容
    assert.ok(
      (item.description.zh || item.description.en).length > 0,
      `说明列应有内容：${item.repo}`,
    )
  }
  assert.equal(items[0].repo, 'ppy-web/dsh-plugin-xiaomi-mimo-tts')
  assert.ok(items[0].description.zh.length > 0, '中文说明应进 zh 槽位')
})

test('radar：英文说明归到 en 槽位，不是硬塞进 zh', () => {
  const md = '| x | [o/r](https://github.com/o/r) | An English only description | agent |'
  const [item] = parseMarkdown(md)
  assert.equal(item.description.en, 'An English only description')
  assert.equal(item.description.zh, '')
})

test('radar：只去链接与反引号，技术标识符（含 * 与 _）保持原样', () => {
  const md = '| x | [o/r](https://github.com/o/r) | 集成 mcp__wps__* 工具 | agent |'
  const [item] = parseMarkdown(md)
  assert.match(item.description.zh, /mcp__wps__\*/)
})

test('radar：表头与分隔行不会被当成条目', () => {
  const items = parseMarkdown('| 插件 | 仓库 | 说明 | 运行级 |\n|---|---|---|---|\n')
  assert.equal(items.length, 0)
})

test('radar：能从说明里的 npm 反引号提取包名', () => {
  const md = '| x | [o/r](https://github.com/o/r) | 说明 npm `@scope/pkg-name` 结束 | agent |'
  const [item] = parseMarkdown(md)
  assert.equal(item.npm, '@scope/pkg-name')
})

test('所有源：缺字段/垃圾输入不抛异常，只返回 null 或空数组', () => {
  for (const source of [dshso, awesome, lanshu, github]) {
    assert.equal(source.normalize(null), null)
    assert.equal(source.normalize({}), null)
    assert.equal(source.normalize('nonsense'), null)
  }
  assert.deepEqual(parseMarkdown(null), [])
  assert.deepEqual(parseMarkdown(''), [])
})
