/**
 * Ranking: relevance × trust × freshness.
 *
 * This is the part the competing tools do not have. One ranks a single
 * GitHub page by stars, which lets a ★70k general-purpose library that merely
 * tagged the topic bury the actual plugin. Another ranks by literal name
 * match, which buries a well-known plugin whose name does not happen to
 * contain the query word (measured: a ★3k terminal UI plugin ranked 117th for
 * "terminal").
 *
 * Neither can express "this catalog has actually run the plugin" or "three
 * independent catalogs agree this exists", which is the signal that actually
 * predicts whether installing it is a good idea.
 *
 * @module dsh-find-plugins/rank
 */

import { search } from './text.js'

/**
 * Catalogs that list ONLY DSH plugins. Membership is evidence of being one.
 *
 * `npm` is deliberately absent: its keyword is self-declared, so a package
 * carrying it proves nothing about being a DSH plugin (the manifest check in
 * `npm-verify.js` is what actually settles that).
 */
const DSH_SPECIFIC = ['radar', 'lanshu', 'awesome', 'dsh.works']

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * How much to believe this entry exists, is a real DSH plugin, and is safe.
 *
 * Corroboration is the strongest available signal: a repo that a DSH-only
 * catalog lists AND that dsh.so verified is a very different proposition from
 * a repo only dsh.so happens to index. That is why a repo absent from every
 * DSH-specific catalog is discounted rather than merely not boosted — dsh.so
 * indexes general agent projects too.
 */
export function trustScore (item) {
  const sources = Array.isArray(item.sources) ? item.sources : []
  let trust = 1

  // Independent corroboration, capped so a long list of mirrors cannot
  // outrank actual verification.
  trust += Math.min(0.45, 0.15 * Math.max(0, sources.length - 1))

  const level = item.verification?.level
  if (typeof level === 'number' && level >= 3) trust += 0.25

  // Radar is the only source that runs what it lists.
  if (item.evidence === 'tested') trust += 0.25

  // Risk is a TIEBREAKER, not a filter.
  //
  // Automated static analysis is a weak signal, and a false positive must not
  // cost a genuinely useful plugin its place — especially since the caller is
  // expected to read the source before installing anyway. The finding is still
  // reported verbatim in the output; the ranking only nudges. An earlier
  // version deducted up to 0.85, which was enough to bury a plugin outright.
  //
  // dsh.so grades risk low/medium/high/critical. Unknown non-low grades take
  // the mild penalty rather than none, so a grade added upstream cannot
  // silently become free.
  const risk = item.security?.riskLevel
  if (risk === 'critical') trust -= 0.3
  else if (risk === 'high') trust -= 0.2
  else if (typeof risk === 'string' && risk !== '' && risk !== 'low' && risk !== 'none') trust -= 0.08

  // Archived says "nobody is maintaining this", which is worth less than a
  // working plugin that merely has a scary scan result.
  if (item.archived === true) trust -= 0.15

  // No DSH-specific catalog knows it → it may not be a DSH plugin at all.
  if (!sources.some((source) => DSH_SPECIFIC.includes(source))) trust *= 0.7
  // Only the raw GitHub topic knows it → nobody has vetted it.
  if (item.evidence === 'topic') trust *= 0.75

  return clamp(trust, 0.25, 2)
}

/**
 * How current the plugin looks.
 *
 * An unknown timestamp scores 0.85, NOT zero. Only a few sources publish
 * `pushedAt`, so most entries have no date at all; treating "unknown"
 * as "abandoned" would silently delete most of the ecosystem from the
 * results. Neutral is the honest score for "we cannot tell".
 */
export function freshnessScore (item, now = Date.now()) {
  if (item.archived === true) return 0.4
  const pushed = Date.parse(item.pushedAt ?? '')
  if (!Number.isFinite(pushed)) return 0.85

  const days = (now - pushed) / 86_400_000
  if (days <= 90) return 1
  if (days <= 180) return 0.95
  if (days <= 365) return 0.85
  if (days <= 730) return 0.7
  return 0.55
}

/**
 * How much of a track record the plugin has.
 *
 * Stars are a terrible PRIMARY signal — that is how a ★70k general library
 * outranks an actual plugin. They are, however, the only signal we have for
 * "has anyone actually used this", and dropping them entirely is worse: a
 * measured experiment with stars removed from the formula put a ★1 repo above
 * a ★3k plugin for the query "terminal", because the ★1 repo's NAME happened
 * to match and relevance was the only thing left.
 *
 * So stars come back as a bounded multiplier on a log scale: ★1 and ★3000
 * differ by ~1.5x, not 3000x. Enough to prefer the plugin people use, not
 * enough to override a genuinely better text match.
 */
export function popularityScore (item) {
  const stars = Number.isFinite(item.stars) && item.stars > 0 ? item.stars : 0
  const scaled = Math.log10(1 + stars) / Math.log10(5001)
  return 0.6 + 0.7 * Math.min(1, scaled)
}

/**
 * Compress relevance so the multipliers can do their job.
 *
 * Raw relevance normalized against the best score is extremely top-heavy: an
 * exact-name boost makes the top entry 1.0 and pushes a still-good second
 * entry to 0.1. No trust or popularity term can overcome a 10x head start, so
 * ranking degenerates into text matching. A power below 1 gives diminishing
 * returns — a 10x raw gap becomes ~2.8x.
 */
const RELEVANCE_EXPONENT = 0.45

/**
 * Rank a candidate pool against a query.
 *
 * @returns {{results: Array<object>, matched: number}} `matched` is how many
 *   entries scored at all — the caller reports it so the model can tell a
 *   narrow query from a broken source.
 */
export function rank (items, query, { limit = 8, now = Date.now() } = {}) {
  const scored = search(query, items)
  if (scored.length === 0) return { results: [], matched: 0 }

  const best = scored[0].score
  const ranked = scored.map(({ item, score }) => {
    const relevance = best > 0 ? Math.pow(score / best, RELEVANCE_EXPONENT) : 0
    const trust = trustScore(item)
    const freshness = freshnessScore(item, now)
    const popularity = popularityScore(item)
    return { item, relevance, trust, freshness, popularity, final: relevance * trust * freshness * popularity }
  })

  ranked.sort((a, b) => b.final - a.final || b.item.stars - a.item.stars)
  return { results: ranked.slice(0, limit), matched: ranked.length }
}
