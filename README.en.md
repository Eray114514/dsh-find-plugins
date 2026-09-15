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

| Query      | This tool                                                   | GitHub page + stars          | Literal name match   |
| ---------- | ----------------------------------------------------------- | ---------------------------- | -------------------- |
| `terminal` | `dsh-TUI` ★2999 first, `dsh-tianshu-tui` ★274 sixth         | terminal coding agent first  | ★1–★20 repos only    |
| `memory`   | `OpenViking` ★36940, `graph-memory` ★618, `dsh-memory` ★184 | general agent libraries only | `graph-memory` first |

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
本次查询了 5 个源：dsh.so ✓(12223 条) · radar ✓(280 条) · awesome-dsh-plugin ✓(3632 条) · 岚叔目录 ✓(558 条) · GitHub topic ✗（HTTP 403）
候选池 14029 条，命中 466 条，返回 6 条。

1. omdsh-dev/DSH-better-sidebar  ★3558  更新于 2026-09-11
   用途：侧边栏完整工作台：内置文件渲染编辑、终端、Git 与子代理，支持三方插件注册新 Tab。
   装它：dsh-better-sidebar
   可信：awesome + github + lanshu · 已收录
   风险：目录审核：review；目录审核风险：medium；目录关注：review（发现安装生命周期脚本：prepare）
```

Three things in that output matter more than they look:

- **the source header** — so the agent can tell "the ecosystem has three of  
  these" from "one catalog timed out";
- **`可信`** — which catalogs know the plugin, its verification level, and its  
  security scan result;
- **`风险`** — the catalogs' own review findings, including things like  
  install-lifecycle scripts.

---

## How it works

**Sources** (all read-only, fetched live, cached in-process):

| Source                    | Size  | What it contributes                                      |
| ------------------------- | ----- | -------------------------------------------------------- |
| dsh.so index              | ~15k  | verification levels (L1–L5), security scans, repo health |
| dsh-plugin-radar          | ~280  | the only catalog that *runs* what it lists               |
| awesome-dsh-plugin        | ~3.6k | hand-written bilingual descriptions, npm names           |
| 岚叔 catalog                | ~560  | archive status, push dates, licenses, review verdicts    |
| GitHub `dsh-plugin` topic | live  | the only source that sees a plugin published today       |

A source that fails reports its own status and contributes nothing. A source  
that fails *after* a successful fetch falls back to its cached copy and is  
labelled as such. Nothing is persisted, so nothing can go quietly stale.

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
  projects too.
- `freshness` — decayed by last push. An unknown date scores neutral, not zero:  
  only two of five sources publish dates, and treating "unknown" as "abandoned"  
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
entries. A few dozen common English↔Chinese pairs are expanded automatically;  
terms only the caller knows (a service name behind the feature, a synonym the  
user did not say) are the caller's to add.

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
node --test test/*.test.mjs
```

Tests are pure-function and network-free, except the fixtures, which are  
**real captured samples** from each source (`test/fixtures/`) — the parsers are  
written against what the sources actually send, not what they ought to send.

Local runs need the peer dependencies resolvable; when developing inside another  
repo, point `node_modules/@deepseek-ai/{dsh-tools,cordis}` at the runtime's copy.

### Optional: GitHub token

The only place credentials are used is the GitHub search source (the other four  
catalogs are public JSON and need no auth). Without a token you get the anonymous  
quota of **10 requests/minute**, which is plenty for normal use — raise it with:

```sh
DSH_FIND_PLUGINS_GITHUB_TOKEN=ghp_xxx     # or the conventional GITHUB_TOKEN
```

Read-only public data; no scope required.

---

## License

MIT
