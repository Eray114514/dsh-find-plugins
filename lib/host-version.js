/**
 * The dsh version this plugin is running inside.
 *
 * The catalogs report `compat` as "verified against dsh X" — but without the
 * host's own version that sentence cannot be judged: X ≠ host is the NORMAL
 * state (a catalog verifies at release time and moves on), and the reader has
 * no way to tell "same release line" from "three releases apart". The host
 * version is the missing half of the comparison, and it is a number users do
 * not have on hand — asking them is not a substitute.
 *
 * Detection is best-effort and returns `null` rather than guessing: a wrong
 * version is worse than no version, because it silently mislabels every compat
 * line in the answer. Every candidate reads a manifest the runtime itself
 * ships — never a profile package, whose version says nothing about the host.
 *
 * No memoization: detection is a handful of reads, runs once per search, and
 * an unconditional cache would ignore the parameters tests pass.
 *
 * @module dsh-find-plugins/host-version
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Test seam / explicit override — the escape hatch for odd installs. */
const ENV_OVERRIDE = 'DSH_HOST_VERSION'

/**
 * `x.y.z` with an optional prerelease/build suffix. Used for acceptance
 * (is this string a version at all?) and for the major.minor comparison —
 * on a 0.x line the minor is the breaking boundary.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-|[+])?/

/**
 * Electron's application roots, tried in order. The `app.asar` paths are
 * readable only where fs is ASAR-patched — i.e. the Electron main process
 * this plugin actually runs in; under plain Node those reads throw and are
 * skipped, and `runtime.json` (an ordinary file on disk) still answers.
 */
const APPLICATION_ROOTS = ['app.asar.unpacked', 'app.asar', 'app']

/** How far to walk up from the CLI entry looking for the host package. */
const MAX_WALK = 10

/** The package whose manifest speaks directly for the host (CLI installs). */
const HOST_PACKAGE = '@deepseek-ai/dsh'

/**
 * Runtime packages that carry the release version on a bundled Desktop host.
 * They are accepted because they are written by the same release process the
 * host is — deliberately NOT an arbitrary manifest: a wrong version mislabels
 * every compat line in the answer, which is worse than answering `null`.
 */
const RUNTIME_PACKAGES = new Set([HOST_PACKAGE, '@deepseek-ai/dsh-desktop-runtime'])

/** Last resort: the Desktop shell. Shares the release line, but is not the host. */
const SHELL_PACKAGE = '@deepseek-ai/dsh-desktop'

function readJson (path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Version of `directory`'s manifest when its name is on `accepted`. */
function versionIfNamed (directory, accepted) {
  const manifest = readJson(join(directory, 'package.json'))
  return manifest !== null && accepted.has(manifest.name) && SEMVER.test(manifest.version ?? '')
    ? manifest.version
    : null
}

/** The host package rooted at `directory`, or null. */
function hostAt (directory) {
  return versionIfNamed(directory, new Set([HOST_PACKAGE]))
}

/**
 * Candidate 1: Electron's resources directory, wherever this build keeps it.
 *
 * Preference order puts the most direct witness first: the host package itself,
 * then the runtime manifest (it names the dsh release directly), then the
 * build record (an ordinary file — readable even where ASAR is not, which is
 * what makes it survive a plain-Node host), and only then the shell, which on
 * a Desktop build is a different package that merely shares the release line.
 */
function fromResources (resourcesPath) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null
  const runtimes = new Set(RUNTIME_PACKAGES)
  const shells = new Set([SHELL_PACKAGE])
  for (const root of APPLICATION_ROOTS) {
    const base = join(resourcesPath, root)
    const host = hostAt(join(base, 'node_modules', '@deepseek-ai', 'dsh'))
    if (host !== null) return host
    const runtime = versionIfNamed(join(base, 'dsh'), runtimes)
    if (runtime !== null) return runtime
  }
  // Bundled build metadata: an ordinary file on disk (not inside ASAR). The
  // version lives at `desktopVersion`, not `version`: it is a build record,
  // not a manifest.
  const build = readJson(join(resourcesPath, 'runtime', 'primary-runtime', 'runtime.json'))
  if (build !== null && SEMVER.test(build.desktopVersion ?? '')) return build.desktopVersion
  for (const root of APPLICATION_ROOTS) {
    const shell = versionIfNamed(join(resourcesPath, root), shells)
    if (shell !== null) return shell
  }
  return null
}

/** Candidate 2: walk up from the CLI entry — the plain `dsh web` install. */
function fromEntry (entry) {
  if (typeof entry !== 'string' || entry === '') return null
  let directory = dirname(resolve(entry))
  for (let depth = 0; depth < MAX_WALK; depth += 1) {
    const version = hostAt(directory)
    if (version !== null) return version
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * The host dsh version, or `null` when it cannot be established.
 *
 * `resourcesPath` / `entry` are parameters so tests can point detection at a
 * fixture tree instead of this machine's install.
 */
export function detectHostVersion ({
  env = process.env,
  resourcesPath = process.resourcesPath,
  entry = process.argv[1],
} = {}) {
  const override = env[ENV_OVERRIDE]
  if (typeof override === 'string' && override.trim() !== '') {
    const version = override.trim()
    return SEMVER.test(version) ? version : null
  }
  return fromResources(resourcesPath) ?? fromEntry(entry)
}

/**
 * How the catalog's checked version relates to the host.
 *
 * - `match` — the exact version the catalog verified against.
 * - `same-line` — same major.minor: on this 0.x line the minor is the
 *   breaking boundary, so a sibling patch is weak evidence, not a warning.
 * - `cross` — a different release line: the verification says nothing about
 *   the host, which is precisely the case worth flagging.
 * - `unknown` — host version not established, or either side unparsable; the
 *   caller then renders the compat line untouched.
 */
export function compareCompat (compatVersion, hostVersion) {
  if (typeof compatVersion !== 'string' || typeof hostVersion !== 'string') return 'unknown'
  const left = SEMVER.exec(compatVersion)
  const right = SEMVER.exec(hostVersion)
  if (left === null || right === null) return 'unknown'
  // Full strings, not the regex match: the pattern stops at the prerelease
  // delimiter, so `0.2.0-rc.1` and `0.2.0-rc.2` would otherwise share group 0
  // and be reported as the same version.
  if (compatVersion === hostVersion) return 'match'
  if (left[1] === right[1] && left[2] === right[2]) return 'same-line'
  return 'cross'
}
