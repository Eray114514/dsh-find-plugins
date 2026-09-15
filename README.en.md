# dsh-find-plugins

Find the **right** DeepSeek Harness plugin, not just a plugin.

[中文](./README.md) | **English**

This plugin gives the agent one tool — `find_dsh_plugins` — that searches the whole  
DSH plugin ecosystem and ranks what it finds by **relevance × trust × freshness**  
instead of stars alone.

---

## Why this exists

The obvious implementations both fail in ways that are easy to measure.

**Ranking one GitHub page by stars** lets a large unrelated repository bury the  
actual plugin. Searching `memory` returns eight general-purpose agent libraries  
and **zero** DSH plugins; searching `terminal` returns a terminal *coding agent*  
at #1.

**Ranking by literal name match** buries a well-known plugin whose name does not  
contain the query word. A ★3k terminal-UI plugin was measured at rank **117** for  
the query `terminal`, behind a wall of ★1 repos.

This plugin instead aggregates several catalogs, weighs them by how much scrutiny each  
one implies, and keeps popularity as a bounded signal rather than the whole  
answer:

| Query      | This tool                                                      | GitHub page + stars          | Literal name match   |
| ---------- | -------------------------------------------------------------- | ---------------------------- | -------------------- |
| `terminal` | `dsh-tianshu-tui` ★277 first (radar ran it; 4 catalogs agree)   | terminal coding agent first  | ★1–★20 repos only    |
| `memory`   | `graph-memory` ★622, `MindMemOS` ★985, `dsh-mnemon` ★374        | general agent libraries only | `graph-memory` first |

---

## Install

```sh
dsh plugin --profile <your-profile> add dsh-find-plugins
```

Then restart DSH. The agent gains one tool, `find_dsh_plugins`.

Requires DSH with `@deepseek-ai/dsh-tools` ≥ 0.1.5-rc.2 and Node ≥ 22.  
Zero runtime dependencies.

---

## What the agent sees

```
本次查询了 7 个源：dsh.so ✓(11322 条) · radar ✓(280 条) · 岚叔目录 ✓(558 条) · awesome-dsh-plugin ✓(3722 条) · npm ✓(50 条 · 相关 4980) · dsh.works ✓(13056 条) · GitHub topic ✓(34 条 · 相关 43)
候选池 16368 条，命中 1185 条，返回 8 条。
（还有 1177 条命中未返回：需要更多就把 limit 调大，上限 20。）

1. huiliyi37/dsh-tianshu-tui  ★276  更新于 2026-09-14
   用途：DeepSeek Harness 的终端 UI（TUI）。
   装它：@huiliyi37/dsh-tianshu-tui
   npm 版本：1.0.0-rc.1（仓库已核对）
   可信：radar + 岚叔目录 + awesome-dsh-plugin + dsh.works · 实测过
   兼容：核对于 dsh 0.1.0-rc.8（2026-08-20）
```

(The output is Chinese — it is written for the agent and the user, not for this README.)

Five things in that output matter more than they look:

- **the source header** — so the agent can tell "the ecosystem has three of  
  these" from "one catalog timed out"; `相关 N` (match total) appears only when a  
  source reports it, because a search-backed source always reads one page;
- **`可信`** — which catalogs know the plugin, its verification level, and its  
  security scan result;
- **`风险`** — the catalogs' own review findings, including things like  
  install-lifecycle scripts;
- **`兼容`** — the dsh version the catalog verified against. Compatibility is  
  this ecosystem's first failure mode (one core release can drop a client module  
  entry point), so when a source states it, it is surfaced;
- **`npm 版本`** — when the install target is an npm package, its registry  
  version; `（仓库已核对）` means the manifest was fetched and its `repository`  
  field matches the entry.

---

## How it works

**Sources** (all read-only, fetched live, cached in-process):

| Source                                | Size  | What it contributes                                      |
| ------------------------------------- | ----- | -------------------------------------------------------- |
| dsh.so index                          | ~15k  | verification levels (L1–L5), security scans, repo health |
| dsh.works registry                    | ~13.5k | the file that proves every entry's install path, the dsh version it was checked against, 17 functional tags, monorepo subpaths |
| dsh-plugin-radar                      | ~280  | the only catalog that *runs* what it lists               |
| awesome-dsh-plugin                    | ~3.6k | hand-written bilingual descriptions, npm names           |
| 岚叔 catalog                            | ~560  | archive status, push dates, licenses, review verdicts    |
| npm registry search                   | live (~5k keyword matches) | the only source that sees a package published to npm with no catalog entry and no repository field |
| GitHub `dsh-plugin` / `dsh-plugins` topic | live | the only source that sees a plugin published today    |

A source that fails reports its own status and contributes nothing. A source  
that fails *after* a successful fetch falls back to its cached copy and is  
labelled as such. Nothing is persisted, so nothing can go quietly stale.

**Install targets** (the `装它` line)

- the source's npm name wins; otherwise `github:owner/repo`;
- **a pinned revision is kept**: given `github:o/r#v0.3.90` the tool answers  
  `#v0.3.90` rather than falling back to a bare repo that installs whatever HEAD  
  is now — the catalog verified that revision;
- a package inside a monorepo keeps `#path:/<subdir>` (joined with `&` when a  
  revision is present too);
- every returned row (≤20) is checked against its npm manifest: when the  
  manifest **declares `dsh`** and its `repository` matches the entry, the target  
  is upgraded to the npm package and its version. npm tarballs are built by the  
  author with their own prepublish step, whereas a `github:` install runs no  
  build at all — a repo that does not commit its compiled output installs a  
  plugin with no code. A row known only from npm whose manifest does not declare  
  `dsh` is dropped and counted (the keyword is self-declared, so it is not  
  evidence).

**Ranking**

```
final = relevance × trust × freshness × popularity
```

- `relevance` — BM25 over name / repo / npm name / description (both languages) / category / topics, with CJK **bigrams** so  
  `跨会话记忆` matches a description saying `跨会话长期记忆`. The raw score is  
  compressed (power 0.45) so the multipliers can actually influence the order.
- `trust` — independent corroboration, dsh.so verification level, radar's  
  run-level testing, security risk, archive status. A repo that **no  
  DSH-specific catalog** knows is discounted: dsh.so indexes general agent  
  projects too, and npm does not count as DSH-specific evidence because its  
  keyword is self-declared.
- `freshness` — decayed by last push. An unknown date scores neutral, not zero:  
  only some sources publish dates, and treating "unknown" as "abandoned"  
  would delete most of the ecosystem.
- `popularity` — stars on a **log scale**, range 0.6–1.3. ★1 and ★3000 differ by  
  about 1.5x. Enough to prefer what people use; not enough to override a  
  genuinely better match.

**Risk grades are a tiebreaker, not a filter.** Automated static analysis is a
weak signal, and a false positive must not cost a useful plugin its place — the
caller is expected to read the source before installing anyway. Findings are
reported verbatim in the output; the ranking only nudges.

**Queries** accept several space-separated terms, and more terms usually means  
**better**, not narrower — mixing languages sharpens the ranking for bilingual  
entries. A few dozen common English↔Chinese pairs are expanded automatically, and  
**singular/plural variants fold in both directions** (`screenshots` and  
`screenshot` return the same candidates — unfolded, one matched 92 entries and  
the other 26 with a different top five). Terms only the caller knows (a service  
name behind the feature, a synonym the user did not say) are the caller's to add.

**The first call does not wait 20 seconds.** Catalog sources are multi-megabyte  
and change slowly, so they are warmed in the background five seconds after the  
plugin loads (query-backed sources are not prewarmed — an empty query fetches  
nothing). Measured cold start: ~20s → ~3s. `DSH_FIND_PLUGINS_NO_PREWARM=1`  
disables it.

**Every call has a 25-second wall-clock budget.** A per-request timeout (up to  
60s for one catalog) does not bound the call, so a source that misses the budget  
is reported as `timeout` — its request keeps running and lands in the cache, so  
the next call is warm — and the other sources answer normally.

---

## Boundaries

Deliberate, and load-bearing:

- **Read-only.** Never installs, uninstalls, enables or disables anything, and  
  never touches a profile or `cordis.patch.yml`.
- **Owns no index.** No bundled snapshot, no on-disk cache. Stale data presented  
  as current is worse than no data.
- **Makes no model call of its own.** The calling agent *is* the model; spending  
  a second call to re-rank would be slower and worse-informed.
- **Knows nothing about any desktop shell around dsh.** This plugin works the same for  
  every DSH user, which is the point.

---

## Development

```sh
npm install
node --test test/*.test.mjs
```

**The suite is fully offline** (`globalThis.fetch` is replaced by a dispatcher  
that throws on any URL it does not recognise, so a stray network call surfaces as  
a failing test) and runs in well under a second. The fixtures are **real  
captured samples** from each source (`test/fixtures/`) — the parsers are written  
against what the sources actually send, not what they ought to send.

### Optional: GitHub token

The only place credentials are used is the GitHub search source (every other  
catalog is public JSON and needs no auth). Without a token you get the anonymous  
quota of **10 requests/minute**, which is plenty for normal use (a call costs two  
requests by default: one page each for the singular and plural topics) — raise it  
with:

```sh
DSH_FIND_PLUGINS_GITHUB_TOKEN=ghp_xxx     # or the conventional GITHUB_TOKEN
```

Read-only public data; no scope required.

---

## License

MIT
