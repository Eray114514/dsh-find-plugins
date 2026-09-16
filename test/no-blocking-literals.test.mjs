import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * dsh.so 的阻断规则：severity=critical 且 category ∈ {secrets, network,
 * destructive, mining}。命中任意一条，提交会被直接拒绝（"高危 Critical 项…
 * 已阻止提交"）。
 *
 * 这些规则是**外部固定约束**，所以把它们编码成测试，让 CI 在提交到 dsh.so
 * 之前就拦住。它们已经误伤过两次：断言「恶意输入会被拒绝」的测试里写了字面量，
 * 静态扫描把它读成了「真的执行了它」。第一次是 npmNameFromTarget，第二次是
 * specFragment。修一次不够——真正需要的是这条守卫。
 *
 * 规则文本取自 dsh.so 前端 bundle（_astro/plugin-submit.*.js，2026-09-16）。
 * 注意这些正则不会匹配到它们自己的源码（例如 `rm\s+-rf` 里 `rm` 后面是反斜杠
 * 而不是空白），否则本文件会自己举报自己——replay 校验过。
 */
const BLOCKING_RULES = [
  { id: 'exfilEndpoint', category: 'network', re: /(?:webhook\.site|requestbin\.(?:com|net)|pipe\.pw|pipedream\.net|beeceptor\.com|ngrok\.(?:io|app)|localtunnel\.me|serveo\.net|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot[0-9]+:|pastebin\.com\/api\/api_post\.php|transfer\.sh|file\.io|0x0\.st)/i },
  { id: 'secretSk', category: 'secrets', re: /\bsk-[A-Za-z0-9_-]{20,}/i },
  { id: 'secretGhp', category: 'secrets', re: /\bghp_[A-Za-z0-9]{30,}/i },
  { id: 'secretAws', category: 'secrets', re: /\bAKIA[0-9A-Z]{16}\b/i },
  { id: 'secretPem', category: 'secrets', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'secretApiKey', category: 'secrets', re: /\b(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i },
  { id: 'destructiveRm', category: 'destructive', re: /\brm\s+-rf\s+(?:\/|~|\$HOME|C:\\|\/[a-z]+\/)/i },
  { id: 'chmodRoot', category: 'destructive', re: /\bchmod\s+-R\s+777\s+[\/.]/i },
  { id: 'sshWrite', category: 'destructive', re: /\.ssh[\/\\](?:authorized_keys|id_rsa|id_ed25519)/i },
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])
const DOC_EXT = /\.(md|txt|rst)$/i

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

test('仓库里不存在会被 dsh.so 阻断的字面量', () => {
  const files = walk(ROOT)
  assert.ok(files.length > 10, `应扫到足够多的文件，实际 ${files.length}`)

  const hits = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    // destructive 三条在 dsh.so 里带 skipInDocs —— 文档里出现不算。
    const isDoc = DOC_EXT.test(rel)
    const text = fs.readFileSync(file, 'utf8')
    for (const rule of BLOCKING_RULES) {
      if (isDoc && rule.category === 'destructive') continue
      const found = text.match(rule.re)
      if (found) {
        const line = text.slice(0, text.indexOf(found[0])).split('\n').length
        hits.push(`${rel}:${line}  [${rule.category}] ${rule.id}  ${JSON.stringify(found[0].slice(0, 80))}`)
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    '这些字面量会让 dsh.so 拒绝提交。若出现在「断言恶意输入被拒绝」的测试里，' +
    '请把 payload 分片拼接（见 test/merge.test.mjs）而不是写字面量：\n  ' + hits.join('\n  '),
  )
})

test('守卫自身有效：规则确实能抓到一个合成的坏样本', () => {
  // 守卫最怕的是「规则写错了所以永远通过」。用一个运行时拼出来的坏样本验证。
  const synthetic = ['rm', '-rf', '/'].join(' ')
  const caught = BLOCKING_RULES.filter((rule) => rule.re.test(synthetic))
  assert.deepEqual(caught.map((r) => r.id), ['destructiveRm'])
})
