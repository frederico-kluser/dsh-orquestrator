# Publication kit — dsh-orquestrator

Everything a plugin directory, an awesome list or a post needs to describe this plugin,
plus the working checklist for the distribution funnel. The one-line values below are the
canonical wording — use them verbatim so the listings stay consistent.

## The submission kit (copy-paste)

| Field | Value |
| --- | --- |
| **Package URL** | `https://github.com/frederico-kluser/dsh-orquestrator` |
| **Install command** | `dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator` |
| **One-line value (English)** | Pick the model your subagents run on — with a reasoning-effort ceiling and an output-token cap — enforced in code on every child DSH starts, whichever tool starts it. |
| **One-line value (Português)** | Escolha o modelo em que seus subagentes rodam — com um teto de esforço de raciocínio e um limite de tokens de saída — imposto em código em todo filho que o DSH inicia, qualquer que seja a ferramenta que o inicia. |
| **One-line value (中文)** | 自己选定子代理运行的模型——附带推理力度上限和输出 token 上限——在代码层面对 DSH 启动的每一个子代理强制执行，无论它由哪个工具启动。 |
| **Primary category** | dsh-plugin.org → **Workflow & Automation** · alexchenzl/dsh-plugin-directory → **Agents & Automation** (secondary facets: Skills & Agents — it ships a global agent skill; UI Enhancements — the native-look task dialog) |
| **License** | MIT |
| **Compatibility** | DSH `>=0.1.6-alpha.2` (`engines.dsh`), tested on `0.1.6-alpha.2`; Node 24, pnpm 11 |
| **Keywords / topics** | `dsh-plugin`, `deepseek-harness`, `cordis`, `cordis-plugin`, `subagents`, `model-routing`, `reasoning-effort`, `agent-skills`, `ai-agents`, `coding-agent` |

Longer blurb (for listing pages that allow it):

> A native-look dialog on every task send lets you pick the model your subagents run on. The pick,
> a reasoning-effort ceiling and an output-token cap are enforced in code on every child DSH starts —
> the `subagent` tools, workflow agents, `ralph` rounds, one-shot jobs and agent teams. Also ships a
> global agent skill (`orchestrate-subagents`) that teaches the main agent to split, parallelize and
> verify work, and marks each subagent in the task page with its model and state. No runtime
> dependencies; the build output is committed; the plugin reads no credentials and starts no process.

## Verification ladder self-audit (dsh.so levels L1–L5)

| Level | Name | Requirement | Status |
| --- | --- | --- | --- |
| L1 | Found | public repo, non-trivial code, README | ✅ |
| L2 | Structured | `package.json` metadata complete (name, description, version, license, `engines.dsh`, `dsh.bundle.patch`), LICENSE file | ✅ |
| L3 | Install Spec | install command declared in the repo, cross-checked with `engines.dsh` | ✅ |
| L4 | Install Tested | `pnpm` install of the tree succeeds in a clean sandbox | ✅ CI (`ci.yml`, `--frozen-lockfile`) + doctor action |
| L5 | Run Tested | `dsh web` smoke run loads the bundle patches without conflict | ✅ validated live on DSH 0.1.6-alpha.2 ([docs/validation/README.md](validation/README.md)); doctor action in CI |

## Funnel checklist

Discovery (GitHub):

- [x] `dsh-plugin` + `deepseek-harness` topics (recognition signal for every crawler)
- [x] Extra topics: `cordis-plugin`, `ai-agents`, `coding-agent`, `agent-skills`
- [x] Repo description aligned with the one-line value
- [x] Release tags (one per version, CHANGELOG section as the release notes) — `v0.8.3` published
- [x] Trust README: one-line value, install command in the header, claimed-seams matrix, supply-chain section, EN + pt-BR + zh-CN

Directories:

- [ ] [deepseekplugin.org /submit](https://deepseekplugin.org/en/submit) — paste the Package URL (instant publish, no account)
- [x] [dsh-plugin.org /submit](https://dsh-plugin.org/submit) — issue filed: [dshplugin/dsh-plugin-hub#137](https://github.com/dshplugin/dsh-plugin-hub/issues/137)
- [x] [alexchenzl/dsh-plugin-directory](https://github.com/alexchenzl/dsh-plugin-directory) — submission issue: [#346](https://github.com/alexchenzl/dsh-plugin-directory/issues/346)

Awesome lists:

- [x] [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) — merged: [PR #583](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/583) (catalog entry, category `model`)
- [x] [dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins) — already listed since 2026-10-05 (`data/plugins.json`); optional correction PR: tags `capabilities` → `models`/`agents`
- [ ] [walkinglabs/awesome-deepseek-harness-plugins](https://github.com/walkinglabs/awesome-deepseek-harness-plugins) — [PR #97](https://github.com/walkinglabs/awesome-deepseek-harness-plugins/pull/97) open
- [ ] [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) — [PR #129](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/129) open (Agent 编排 section)
- [ ] [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — [PR #6960](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6960) open (Models & Providers, CI green)

Registry (optional):

- [ ] npm publish (`dsh-orquestrator` name is free) — enables jsDelivr CDN and registry search

Growth (drafts ready, kept out of git; posts are manual):

- [ ] Juejin (掘金) — technical essay, 降本增效 angle: subagents on a cheap model + effort/token ceilings
- [ ] V2EX — technical dissection: the start guard, the seams, what the plugin does not do
- [ ] Reddit — r/DeepSeek (and r/LocalLLaMA if it fits): one-injection install, in-code enforcement
- [ ] X/Twitter — screenshot + one-liner + install command
- [ ] Xiaohongshu (RED) — micro-video of the dialog and the subagent marks