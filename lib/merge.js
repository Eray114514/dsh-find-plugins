/**
 * The one internal shape, plus the merge that turns every catalog into one
 * de-duplicated list.
 *
 * Every source module normalizes into this shape (see `lib/sources/*`), so
 * merging is a pure function with no per-source knowledge — which is what
 * makes it unit-testable without a network.
 *
 * @module dsh-find-plugins/merge
 */

/**
 * How much a source is worth believing, and what kind of scrutiny it implies.
 * The rank drives both `evidence` and the trust multiplier in `rank.js`.
 */
export const SOURCE_CLASS = {
  'dsh.so': { rank: 5, evidence: 'verified' },
  radar: { rank: 4, evidence: 'tested' },
  lanshu: { rank: 3, evidence: 'curated' },
  awesome: { rank: 3, evidence: 'curated' },
  // dsh.works records the install path it proved (its `evidence` field is the
  // file that path came from), which is curation of the same strength as a
  // hand-written catalog — but it never RUNS a plugin, so it is not `tested`.
  'dsh.works': { rank: 3, evidence: 'curated' },
  // npm proves a package exists and is installable, nothing more: the
  // `dsh-plugin` keyword is self-declared and can be squatted. `indexed` is the
  // tier that says exactly that.
  npm: { rank: 2, evidence: 'indexed' },
  github: { rank: 1, evidence: 'topic' },
}

export const EVIDENCE_RANK = { verified: 5, tested: 4, curated: 3, indexed: 2, topic: 1 }

// A repo name stops at whitespace, a path separator, a query/hash, and at the
// punctuation that surrounds a repo inside prose or a markdown link
// (`[o/r](https://github.com/o/r)` must not yield `r)`). Greedy and
// unanchored on purpose: anchoring on `$` makes the trailing `)` unmatchable
// and the whole URL fail.
const REPO_NAME = '[^/\\s#?)\\]}\'"`,;]+'

/** `owner/name` from any GitHub URL, or null. */
export function repoFromUrl (url) {
  if (typeof url !== 'string') return null
  const m = new RegExp(`github\\.com[/:]([^/\\s]+)/(${REPO_NAME})`, 'i').exec(url.trim())
  if (m === null) return null
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`
}

/** `owner/name` from a `github:owner/name#ref` style spec, or null. */
export function repoFromSpec (spec) {
  if (typeof spec !== 'string') return null
  const m = new RegExp(`^(?:github:|git\\+https?://github\\.com/|https?://github\\.com/)([^/\\s#]+)/(${REPO_NAME})`, 'i').exec(spec.trim())
  if (m === null) return null
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`
}

// A fragment we are willing to hand back to pnpm: a tag, branch, semver
// selector, commit SHA, or a `path:/sub` (optionally joined with `&`). No
// whitespace and no shell metacharacters — the fragment is echoed into a
// command the user will run, so a source publishing junk must not smuggle
// anything through it.
const SPEC_FRAGMENT = /^[A-Za-z0-9._/@:+-]+$/

/**
 * The `#…` part of an install spec, or null.
 *
 * Sources publish the revision they verified (`github:o/r#v0.3.90`); dropping
 * it turns "install the version this catalog checked" into "install whatever
 * HEAD is right now", which is a different and unverified thing.
 */
export function specFragment (spec) {
  if (typeof spec !== 'string') return null
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const fragment = spec.slice(hash + 1).trim()
  return SPEC_FRAGMENT.test(fragment) ? fragment : null
}

/** Coerce whatever a source calls a description into `{ en, zh }`. */
export function normalizeDescription (value) {
  if (value === null || value === undefined) return { en: '', zh: '' }
  if (typeof value === 'string') return textDescription(value)
  return {
    en: typeof value.en === 'string' ? value.en : '',
    zh: typeof value.zh === 'string' ? value.zh : '',
  }
}

/**
 * Sort a bare description string into the right language slot.
 *
 * Sources that publish a single string do not label its language, and several
 * of them write Chinese — defaulting every string to `en` would file a
 * Chinese description under the wrong language and make the zh-preferred
 * rendering fall back to English. Presence of CJK is a reliable tell.
 */
export function textDescription (text) {
  const value = typeof text === 'string' ? text : ''
  return /[\u4e00-\u9fff]/.test(value)
    ? { en: '', zh: value }
    : { en: value, zh: '' }
}

/** Prefer the richer description: a bilingual one beats a single-language one. */
export function betterDescription (a, b) {
  const score = (d) => (d.zh ? 1 : 0) + (d.en ? 1 : 0) + (d.en.length + d.zh.length) / 1000
  return score(b) > score(a) ? b : a
}

/** ISO-8601 strings compare lexicographically; empty sorts last. */
export function latestStamp (a, b) {
  if (!a) return b || null
  if (!b) return a
  return a > b ? a : b
}

/** Build a normalized entry. Sources call this; it is the only constructor. */
export function entry (fields) {
  const repo = fields.repo || null
  const npm = fields.npm || null
  const sourceId = fields.source
  const cls = SOURCE_CLASS[sourceId] || { rank: 0, evidence: 'topic' }
  return {
    repo,
    // A package with no repository is still a plugin someone can install —
    // `dsh plugin add <name>` never needed GitHub. Those entries get their own
    // key namespace so they cannot collide with a repo key, and npm-only
    // entries stay distinguishable everywhere downstream (`item.repo === null`).
    key: repo ? repo.toLowerCase() : (npm ? `npm:${npm.toLowerCase()}` : null),
    url: fields.url || (repo
      ? `https://github.com/${repo}`
      : (npm ? `https://www.npmjs.com/package/${npm}` : null)),
    owner: repo ? repo.split('/')[0] : null,
    name: repo ? repo.split('/')[1] : (fields.name || (npm ? npm.split('/').pop() : null)),
    description: normalizeDescription(fields.description),
    stars: Number.isFinite(fields.stars) ? fields.stars : 0,
    pushedAt: fields.pushedAt || null,
    archived: fields.archived === true,
    license: fields.license || null,
    npm,
    npmVersion: fields.npmVersion || null,
    // The revision the source published with the install spec, and the
    // monorepo subdirectory a package lives in — both are part of installing
    // the thing the catalog actually checked.
    ref: fields.ref || null,
    path: fields.path || null,
    // Which dsh version the source verified this entry against. Compatibility
    // is the failure mode this ecosystem actually has (a core release can drop
    // a client module the plugin imports), so when a catalog states it, it is
    // reported rather than dropped.
    compat: fields.compat || null,
    category: fields.category || null,
    topics: Array.isArray(fields.topics) ? fields.topics.filter((t) => typeof t === 'string') : [],
    verification: fields.verification || null,
    security: fields.security || null,
    notes: Array.isArray(fields.notes) ? fields.notes : [],
    sources: [sourceId],
    evidence: cls.evidence,
  }
}

/**
 * Merge entries from every source into one list keyed by repository.
 *
 * The merged entry keeps the BEST of each field rather than the first seen:
 * one catalog may know the npm name while another knows the license, and a
 * third may be the only one that noticed the repo is archived.
 */
export function mergeEntries (entries) {
  const byKey = new Map()
  for (const raw of entries) {
    if (!raw || !raw.key) continue
    const cur = byKey.get(raw.key)
    if (cur === undefined) {
      byKey.set(raw.key, {
        ...raw,
        sources: [...(raw.sources ?? [])],
        notes: [...(raw.notes ?? [])],
        topics: [...(raw.topics ?? [])],
      })
      continue
    }
    cur.sources = [...new Set([...cur.sources, ...(raw.sources ?? [])])]
    if ((EVIDENCE_RANK[raw.evidence] || 0) > (EVIDENCE_RANK[cur.evidence] || 0)) cur.evidence = raw.evidence
    cur.description = betterDescription(cur.description, raw.description ?? { en: '', zh: '' })
    if (raw.stars > cur.stars) cur.stars = raw.stars
    cur.pushedAt = latestStamp(cur.pushedAt, raw.pushedAt)
    cur.archived = cur.archived || raw.archived === true
    cur.license = cur.license || raw.license
    cur.npm = cur.npm || raw.npm
    cur.npmVersion = cur.npmVersion || raw.npmVersion
    cur.ref = cur.ref || raw.ref
    cur.path = cur.path || raw.path
    cur.compat = cur.compat || raw.compat
    cur.category = cur.category || raw.category
    cur.topics = [...new Set([...cur.topics, ...(raw.topics ?? [])])]
    cur.verification = cur.verification || raw.verification
    cur.security = cur.security || raw.security
    cur.notes = [...new Set([...cur.notes, ...(raw.notes ?? [])])]
  }
  return [...byKey.values()]
}

/**
 * The install target, WITHOUT a profile name.
 *
 * Deliberately not `dsh plugin --profile web add …`: the profile is the
 * caller's business, and hardcoding one silently installs into the wrong
 * place for anyone who renamed it.
 *
 * The source's own revision and monorepo subpath are KEPT. A catalog that
 * published `github:o/r#v0.3.90` verified v0.3.90, and downgrading that to a
 * bare repo means "install whatever HEAD happens to be" — which can be
 * unverified, or simply broken (`github:` installs run no build, so a repo
 * whose lib/ is not committed produces a plugin with no code). Subpaths are
 * joined with `&`, the form the ecosystem already uses for
 * `github:o/r#<rev>&path:/sub`.
 */
export function installTarget (item) {
  if (item.npm) return item.npm
  if (!item.repo) return null
  const parts = []
  if (item.ref) parts.push(item.ref)
  // `path:` inside the ref already names the subdirectory.
  if (item.path && !String(item.ref ?? '').includes('path:')) parts.push(`path:/${item.path}`)
  return `github:${item.repo}${parts.length > 0 ? `#${parts.join('&')}` : ''}`
}

/**
 * Pull the package/spec out of a source's own install command, e.g.
 * `dsh plugin --profile web add github:owner/repo` → `github:owner/repo`.
 * Sources publish commands with their own profile baked in; we only want the
 * target. Requires the `plugin` subcommand so prose that merely contains the
 * word "add" is not mistaken for an install command.
 */
export function targetFromCommand (command) {
  if (typeof command !== 'string') return null
  const m = /\bplugin\b[^\n]*?\sadd\s+(\S+)\s*$/.exec(command.trim())
  return m ? m[1] : null
}

// A real npm package name: optional scope, no spaces, no shell metacharacters.
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * A bare npm package name (not a git spec, path, URL, or a whole command), or
 * null.
 *
 * Sources are inconsistent about what they put in an `install`/`npm` field:
 * some publish `dsh-context`, some publish the full
 * `dsh plugin --profile web add github:owner/repo`. Treating "does not look
 * like a git spec" as "is an npm name" let an entire command through, which
 * then rendered as a nonsense install target. So: unwrap a command first, then
 * require the result to actually LOOK like a package name.
 */
export function npmNameFromTarget (target) {
  if (typeof target !== 'string') return null
  let t = target.trim()
  if (t === '') return null

  const fromCommand = targetFromCommand(t)
  if (fromCommand !== null) t = fromCommand

  if (/^(github:|git\+|git@|https?:|\.{1,2}\/|\/)/.test(t)) return null
  if (t.includes('#')) return null

  // `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`
  const at = t.lastIndexOf('@')
  if (at > 0) t = t.slice(0, at)

  return NPM_NAME.test(t) ? t : null
}

