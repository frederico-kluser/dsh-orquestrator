# dsh-orquestrator

[![ci](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). When you send a
new task, a dialog in the stock DSH look asks one question:

**Should subagents run on a different model** than the one selected for the main agent?

If yes, you pick the model, and the plugin enforces it **in code**, on every child DSH
starts for that session: the `subagent` tools, but also the agents a `workflow` starts,
`ralph` rounds, one-shot background jobs and agent teams. The main agent cannot talk its way
around it: it is not an instruction to the model, it is the plugin standing in the doors DSH
starts children through. See [Which delegations are covered](#which-delegations-are-covered).

Every governed child also gets a **reasoning-effort ceiling** and an **output-token cap**,
because DSH otherwise runs a re-routed child at its route's default (`max` on many setups):
the cause of subagents that burn their whole budget on one edge case. See
[Reasoning effort](#reasoning-effort).

**Cancel, Escape and the close button send the task exactly as DSH always did.**
Nothing else about DSH changes.

| Dark | Light |
| --- | --- |
| ![Dialog, dark theme](docs/img/modal-dark.png) | ![Dialog, light theme](docs/img/modal-light.png) |

With a model picked from the composer's own list:

![Dialog with a subagent model chosen](docs/img/modal-filled.png)

> Português: [README.pt-BR.md](README.pt-BR.md)

> **0.5.0 removed the independent reviewer** that 0.2 to 0.4 offered next to the model
> choice. What governs the models stayed, and it now is the plugin's only mechanism.
> Stored choices and patch files written for 0.4 keep working (the reviewer fields are
> ignored, with a warning). Why: [Why the reviewer was removed](#why-the-reviewer-was-removed).

## Install

```sh
dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator
dsh --profile web            # (re)start it: see the note below
```

**Restart `dsh` after installing or updating, not only the page.** A plugin's host half is loaded when `dsh`
starts and its browser half when the page loads, so refreshing the page alone leaves the old host half running
(and the old guard with it). From 0.5.1 the two halves also keep talking to 0.2 to 0.4 halves while you do
(a disabled `reviewer` block stays on the wire for that), so a mixed state still saves; before that, it failed with
"config does not match the expected shape".

From a local clone: `dsh plugin --profile web add /path/to/dsh-orquestrator`.

Tested on **DSH 0.1.6-alpha.2** (Node 24, pnpm 11). The committed `lib/` is the
build output, so no build step is needed to install.

## Use

Type anything in the composer and send it. The dialog appears before **every** message you
send — plain text, `@file` references or `/skill` invocations, in any conversation, even while
a turn is running:

- **Subagent model**: turn it on and pick a model from the same provider-grouped
  list the composer's model seat uses. It applies to every subagent, including the agents a
  workflow starts. Off means subagents keep the main agent's model. The dialog shows short,
  dated notes for models that need them (for example: MiMo-V2.6-Pro can take minutes per
  turn at high effort; GLM 5.3 is text only).
- **Reasoning effort** (collapsed, shown once a model is picked): how hard the model may
  think. It defaults to the recommended level for the model; open it to see or change it.
- **There is no "do not ask again"**: the modal is raised for every message you send and
  nothing can silence it. One answer never hides it from a later message or from
  another conversation. The last confirmed choice only pre-fills the dialog.
- **Cancel / Esc / ✕**: send the message with stock behavior and forget any stored choice.

`/orquestrar` opens the same dialog on demand (to change or clear the stored choice).

A small chip under the composer (the `conversation.composer.dock` row) always shows this
conversation's orchestration — `Subagents: <model> · <effort>` when a model is chosen,
`Subagents: same as the main agent` when not — and clicking it opens the same dialog.

Nothing skips the dialog: only an empty send passes straight through. Earlier releases skipped
`/` lines, messages sent while a turn was running and sub-agent conversations, so every task
that began with a skill invocation (`/skill ...`) went out with no dialog at all; from 0.6.0
the question is asked no matter what the message looks like.

## Which delegations are covered

DSH has more ways to start a child than the two `subagent` tools. All of them go through two
doors, `SubagentRuntime.start()` and `startContinuable()`, and the **start guard**
(`src/guard.ts`) stands in both. For a session with a confirmed choice (stored, an ancestor's, or
`defaults`) it plans every child: the picked route, the effort the user asked for or the model's
ceiling, and the output-token cap, handed to DSH as the child's `agentOptions`.

| How DSH starts the child | Model, effort ceiling, token cap |
| --- | --- |
| `subagent` and `subagent_fork` tools (the standard preset) | yes |
| `subagent` as a one-shot background job (`backgroundMode: one-shot`, `run_in_background: true`) | yes |
| the `workflow` tool: every `agent()` call of the script | yes |
| `ralph` (off in the standard preset; it runs on the workflow engine) | yes |
| agent teams (experimental) | yes |
| `codex`, `claude-code` and ACP providers | no: they run their own agents on their own models and take no agent options (the plugin logs a warning once per provider) |
| the DSH SDK provider (a separate DSH child runtime) | yes when a subagent model is picked (it takes the route, effort and token limit); with no model picked its child keeps the provider's own model |

What was run live, on the three target models: the `subagent` tool (foreground and background),
`subagent_fork`, and the `workflow` tool (with the default `override`, with `keep` and with the
enforcement off), headless and through the dialog in a real browser. The other rows follow from the
doors they use, which the contract tests pin against the DSH source (`ralph` runs on the workflow
engine, a one-shot job and the team call `start` / `startContinuable`, the SDK provider takes agent
options). No live run used a one-shot background job, `ralph`, an agent team, the SDK provider or
`codex` / `claude-code` / ACP.

Why a guard and not a tool wrapper: a wrapper never saw a `workflow` call's agents, because the
engine starts them through the service itself. In the session that exposed it, 34 workflow
agents ran on Claude Sonnet 5.5 at `max` (about 7.2 million output tokens and 1.26 billion
cache-read tokens) although DeepSeek V4.1 Flash was confirmed for subagents. Version 0.3 and
older have this hole; [the validation page](docs/validation/README.md) reproduces it on an isolated DSH and shows it closed.

What a governed child gets: the model the user picked, the effort the user picked (or the model's
ceiling) and the output-token cap. The main agent is never touched, and a session with no confirmed
choice is never touched.

If the model you confirmed is gone (renamed or removed from your DSH settings after you confirmed it),
the child's start is rejected with a message that says so and what to do (`/orquestrar`, or cancel the
dialog). The alternatives are worse: running the child on the main agent's model is the bug this
design exists to prevent, and forcing the dead route makes every workflow agent fail into a silent `null`.

A model the caller names itself (`agent({ provider, model })` in a workflow script) loses to the
user's pick by default (`children.explicitModel: override`): the dialog is the user's explicit
instruction. `keep` lets the caller's model stand, under the same ceilings. A choice with an effort but
no model (`defaults.workerEffort` alone) leaves children on the main agent's model under that level,
and a model a script names itself stands.

## Configuration

Everything is optional; without configuration the plugin does nothing until a user
confirms the dialog. Add overrides to your profile's `cordis.patch.yml`
(a patch replaces the row's whole `config`):

```yaml
- id: orquestrator
  config:
    # Headless/TUI/SDK sessions have no dialog: apply this to every session.
    defaults:
      subagentModel: { provider: azure-opencode, model: DeepSeek-V4.1-Flash }
      workerEffort: medium           # optional; absent = the recommended level for the model
    effort:                        # ceiling on the reasoning effort of every subagent; false turns it off
      worker: medium
    limits:                        # output tokens per model request, reasoning included; false = no cap
      workerMaxTokens: 64000
    children:                      # the start guard; false switches the enforcement off (the dialog still stores choices)
      explicitModel: override      # override | keep: a model the caller names itself, e.g. agent({ model }) in a workflow script
    persist: true                  # remember choices across restarts
    stateDir: ~/.dsh/dsh-orquestrator
    maxSessions: 500               # stored sessions before the oldest are pruned
```

Fields of 0.4 and older that belonged to the reviewer (`tools`, `reviewerProvider`, `reviewerContext`,
`structuredVerdict`, `workerHandoff`, `maxWorkerReportChars`, `retryOnTokenLimit`, `workspaceChecks`,
`sensitivePaths`, `defaults.reviewer`, `effort.reviewer`, `limits.reviewerMaxTokens`) are ignored with a
warning in the DSH log, so an existing patch file keeps loading.

### Reasoning effort

DSH resolves a child's options from its parent, and when the route changes without an
effort it clears the parent's level so the new model "resolves its own default". On setups
whose routes say `reasoning: max` that means every re-routed child thinks at `max`, with the
route's full declared output ceiling (131K to 943K tokens on the routes this was built on) as its limit.

The plugin therefore asks DSH for the model's own ladder and applies a **ceiling**, never a
setting: a route already at or below it is left alone, and a ladder that skips rungs (GLM 5.3
offers `low`, `high`, `max`) gets the highest rung not above the ceiling. `off` is never picked
on its own. The ceiling is, in order: the level picked in the dialog (it may be above the
ceiling), `effort.worker`, the model's row in [`src/models.ts`](src/models.ts) (dated, with its
sources), and `medium`.

| Model | Subagent ceiling |
| --- | --- |
| DeepSeek V4.1 Flash | `medium` |
| MiMo-V2.6-Pro | `low` |
| GLM 5.3 / GLM 5.3 Flash | `high` |
| Claude Sonnet / Opus | `high` |
| Anything else | `medium` |

`limits` caps the output tokens of a single model request (reasoning included) and only ever
lowers a ceiling the model is known to have. Why these numbers, and which study recommendations
were left out and why: [docs/estudos/](docs/estudos/README.md).

## Limits

- **The plugin controls which model runs and how hard it thinks. It does not check what a
  subagent produces.** The main agent reads the result as DSH always delivered it; if you want a
  check, ask the main agent to verify, or run the project's own tests. (An independent reviewer
  used to do this; see [below](#why-the-reviewer-was-removed).)
- Providers that cannot take agent options (`codex`, `claude-code`, ACP) keep the models they
  run on; the plugin logs a warning (once per provider) and does not touch their children. A
  provider that runs its own default route (the SDK provider) is left alone when no subagent
  model is picked, because the plugin cannot know what its child runs on.
- **The output-token cap is not durable for `continuable` children.** When DSH later resumes a
  finished child (a follow-up message after it released the child, or after a restart) it rebuilds
  the child's options from the recorded descriptor, which holds the provider, model and effort but
  not the token limit. The effort ceiling survives; the cap applies to the first run only. Fixing it
  needs another seam (see [decisoes.md](docs/estudos/decisoes.md), N21).
- A model the main agent names in a `subagent` call (DSH's model selection, on in the standard
  preset) is ignored while a choice is confirmed; `override` applies the same rule to every other
  caller. A token limit a caller sets (an operator's tool row, a team roster) is never raised: the
  smaller of the caller's and the plugin's stands.
- Unknown top-level configuration fields are ignored with a warning in the DSH log (a mis-indented
  `explicitModel: keep` would otherwise run as `override`).
- DSH has no hook around a child start (`subagent/start` fires after the child exists), so the
  start guard installs its own `start` and `startContinuable` on the service instance. The
  contract tests (`test/contract/`) pin that assumption against a DSH checkout and a real
  `SubagentRuntime`, and fail first when DSH changes it. They run on a machine that has a DSH
  checkout (`DSH_CHECKOUT`), not in CI. If the service cannot be wrapped the plugin fails to
  load; it never half works. `children: false` takes the guard out.
- The reasoning-effort ceiling and the token cap apply to the children the plugin governs,
  never to the main agent. A model the LLM runtime cannot describe but can call keeps exactly
  the options the user picked (the log says so); one it cannot call at all is rejected, as
  described above.
- The model advice in the dialog (notes, ceilings) is dated data from studies of
  September and October 2026 and goes stale in weeks; a model it does not know gets
  the generic ceiling and no notes.
- Portuguese and Chinese strings ship as dictionaries. They appear when DSH (or
  another plugin) has registered that language; this plugin never registers a
  language itself, to avoid clashing with the plugin that owns it.

## Security model

The plugin runs no code of the subagents and starts no process of its own. It changes only the
options DSH starts a child with. What it does: serves its one route behind the DSH trust fence
(Host/Origin fence and browser authentication) with strict wire validation, keeps its state in
an owner-only file that holds provider and model ids and no credentials, and never reads, writes or
forwards API keys. What it does **not** do: it provides no sandbox, filters no network and controls
no process environment. What subagents may do is decided by the permission preset of the session,
exactly as without the plugin.

## Why the reviewer was removed

Versions 0.2 to 0.4 also offered an independent reviewer: a second model that checked each
subagent's work, fixed what was broken and delivered the result to the main agent in the
subagent's place. Version 0.5.0 removed it, for three reasons:

1. **It was an LLM judging an LLM.** What the plugin enforces in code (which model runs, how hard it
   thinks, how much it may write) is deterministic, and the main agent cannot bypass it. A reviewer's
   `APPROVED` is an opinion, and the plugin could only check its format and its coherence.
2. **It cost about twice as much and made every delegation wait for a second model**, and it covered two
   of the paths DSH starts children through, not the agents of a workflow.
3. **It needed a second mechanism.** The reviewer required wrapping the `subagent` tools; the start
   guard alone already governs every path (verified live, with the wrapper out of the way), so keeping
   both only kept two ways to get the same result.

The studies, the reviewer protocol and the decisions behind it stay in the repository as history:
[docs/estudos/](docs/estudos/README.md), [docs/pesquisa/padrao-revisor.md](docs/pesquisa/padrao-revisor.md)
(Portuguese) and decision D16 in [docs/estudos/decisoes.md](docs/estudos/decisoes.md). Version
0.4.0 is the last one that has it.

## Verified

Version 0.5.0 was validated on a real DSH 0.1.6-alpha.2 with the three target models only: GLM 5.3
(main agent), DeepSeek V4.1 Flash (subagents) and MiMo-V2.6-Pro (the model a workflow script names
itself). Headless, eight scenarios read back from the session logs: the workflow agents on the
picked model at the model's ceiling with a 64 000-token cap; `explicitModel: override` and `keep`;
the enforcement switched off; the `subagent` tool in the background and `subagent_fork` governed with
no tool wrapper at all; and a confirmed model that no longer exists rejected with a message that names
it, through a workflow and through the tool. Through the dialog in a real browser: 65 checks, including
a real delegation and a real workflow whose children were read back from the logs. A stored choice
written by 0.4.0 (with its reviewer block) loaded and was rewritten in the new shape. Evidence and
findings, including what was not covered: [docs/validation/README.md](docs/validation/README.md).

## Develop

```sh
pnpm install
pnpm run check          # typecheck + build + tests
pnpm run check:lib      # the committed lib/ must equal a fresh build (run it after committing lib/)
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test   # also pins the DSH seams this plugin uses
```

Live validation against a real DSH uses only the three target models and fails if any other
one runs: `scripts/e2e/run-workflow.sh` (the `workflow`, `subagent` and `subagent_fork` tools and the
start guard, headless), with `session-config.mjs` reading back what each session was asked, and
`scripts/e2e/ui-e2e.mjs` (browser). `scripts/e2e/setup-isolated-home.sh` builds the isolated
`DSH_HOME` they expect and `scripts/e2e/with-keys.sh` runs them with only the two API keys the
three models need. See [docs/validation/README.md](docs/validation/README.md).

Layout: `src/` (host), `src/client/` (browser), `test/` (unit, integration,
contract), `scripts/e2e/` (headless and browser runs against a real DSH),
`docs/` (design, validation, and `estudos/`: the studies, their digest and the decision log).

## License

MIT
