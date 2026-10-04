# Changelog

## 0.4.0

**The model, the effort ceiling and the token cap you confirm now reach every child DSH
starts, not only the ones started by the `subagent` tools.** Until now a session that had
confirmed "subagents run on DeepSeek V4.1 Flash" ran the agents of a `workflow` on the main
agent's model: in the session that exposed it, 34 agents on Claude Sonnet 5.5 at `max`, about
7.2 million output tokens and 1.26 billion cache-read tokens, none on DeepSeek. The plugin had
stored the choice and nothing violated it: it only wrapped the `subagent` and `subagent_fork`
tools, and a workflow (like `ralph`, a one-shot background `subagent` job and the experimental
agent team) starts its children through `ctx.subagents.start()` / `startContinuable()` itself.
Reproduced on an isolated DSH with the three target models (0.3.0: two workflow agents on GLM 5.3
at `high`, no token cap, although DeepSeek V4.1 Flash was configured for subagents) and closed
(0.4.0: DeepSeek V4.1 Flash at `medium` with 64 000 output tokens).

- **Start guard (`src/guard.ts`).** `SubagentRuntime.start` and `startContinuable` are the only
  doors (a provider is started from `start` alone and a child agent is created from those two paths
  alone; pinned against the DSH source), so the plugin installs its own `start` and `startContinuable`
  on the service instance, reached through the service proxy's `Symbol.for('cordis.original')`
  (DSH has no hook around a child start). For a session with a confirmed choice (stored, an ancestor's
  or `defaults`) every child the pipeline did not start is planned like a worker: the picked route, the
  effort the user asked for or the model's ceiling, the output-token cap, handed to DSH as `agentOptions`.
  The main agent and sessions with no confirmed choice are never touched.
- **The pipeline's own starts are marked, not detected.** Its worker, retry and reviewer are planned by
  the pipeline; a process-wide `WeakSet` of request objects tells the guard to leave them alone (a
  reviewer that keeps the worker's route carries no options, so content cannot tell).
- **A model the caller names itself** (`agent({ provider, model })` in a workflow script) loses to the
  user's pick by default; `children.explicitModel: keep` lets it stand under the same ceilings. With only a
  reviewer picked, children stay on the main agent's model under the ceilings and a named model stands.
  `children: false` turns the guard off (the 0.3 behavior).
- **No reviewer for workflow agents or one-shot jobs**, on purpose: a script consumes its agents' results
  itself (often as schema-checked data) and a job delivers through the job store, so a replacement report
  would break both. The dialog now says so (one line under each switch, en, pt, zh) and the README has a
  table of every path with what applies to it.
- **Fails loud at load, never half works.** A service that cannot be wrapped is a plugin load error. A child
  the guard cannot plan becomes a log line and DSH's own start (it never breaks a delegation); a
  cancellation passes through; a provider that cannot take agent options (`codex`, `claude-code`, ACP) is
  left alone with one warning per provider.
- **A confirmed model that is gone rejects the start.** If the LLM runtime no longer knows the model you
  confirmed (renamed or removed after you confirmed), the child's start fails with a message that names it
  and says what to do. Running the child on the main agent's model is the bug of this release, and forcing
  the dead route fails every workflow agent into a silent `null`. Only the user's own pick is defended this
  way; a model the caller named (`keep`) is left to DSH.
- **Fixes from an independent review (adversarial and mutation testing).** The mark survives a copy of the
  request and the guard marks its own output (two live copies of the plugin plan a child once; the newer
  configuration wins). The planner now plans against what DSH really merges: a child on the parent's own
  route inherits the parent's effort, and DSH hands the parent's creation token limit down on every route
  (the ceiling missed both); an effort the caller named that the model does not offer is no longer spread
  back in by the merge; a token limit a caller set is never raised. The wait for a model description races the
  call's cancellation. A provider that runs its own default route (the SDK provider) is left alone when no
  model is picked. Unknown top-level configuration fields now log a warning (a mis-indented
  `explicitModel: keep` ran, silently, as `override`). The dialog's reviewer hint no longer says "the model
  above" in a reviewer-only choice.
- **Documented, not fixed:** the output-token cap does not survive DSH's cold resume of a finished
  `continuable` child (the descriptor keeps provider, model and effort only); the effort ceiling does.
- **Contract tests against the real thing.** Six new pins on the DSH source (the two doors and their only
  callers, no hook around a start, the proxy symbol, the workflow engine's `agentOptions`, which providers
  take agent options, the shape of `AgentOptions`) and a suite that runs the guard on the built
  `SubagentRuntime` inside a real Cordis context: installed by one plugin, called through another's proxy.
- **Live validation on the three target models** (GLM 5.3 main, DeepSeek V4.1 Flash subagent, MiMo-V2.6-Pro
  reviewer), the bug reproduced and closed, `override`, `keep` and the switch, the `subagent` + reviewer path
  unchanged, and 58 browser checks: [docs/validation/README.md](docs/validation/README.md).
- **Validation tooling.** `scripts/e2e/run-workflow.sh` (the workflow scenarios), `setup-isolated-home.sh`
  and `with-keys.sh` (only the two API keys the three models need reach the agents). The browser script's
  `cancel` and `command` phases still expected the "do not ask again" checkbox that 0.3.0 removed; they now
  check that the modal always asks. Lesson recorded in the setup script: never round-trip `settings.yaml`
  through a YAML library (YAML 1.1 turns a reasoning ladder's `off:` key into `false:` and DSH then registers no
  LLM adapter at all).

Upgrading: nothing to migrate; stored choices keep working. The one behavior change is the point of
the release: in a session with a confirmed choice, workflow agents now run on the subagent model. Restart
`dsh` to load it. `children: false` restores the old behavior.

Tests: 388 (357 without a DSH checkout, which is what CI runs), up from 260 (242). A mutation audit of the guard and the
code around it killed 283 of 295 single-line mutants; the other 12 are equivalent (they cannot change behavior).

## 0.3.0

**The "Do not ask again in this conversation" checkbox is gone: the modal now appears
for every new task and nothing can hide it.** A remembered silence always spread — the
DSH web client reuses a workspace's empty session for every "New session"
(`ui-workspace` `connectWorkspace`), so one answer silenced the modal for every
conversation the user opened in that workspace, with no way left to configure the
orchestration there. Now every new task raises the modal and the last confirmed choice
only pre-fills it. `remember` is dropped from the configuration schema; a legacy field
is accepted and ignored, so stored choices keep working as pre-fill. 260/260 tests.

## 0.2.1

**"Do not ask again in this conversation" is bound to that conversation alone.**
DSH's web client reuses a workspace's empty session for every "New session"
(`ui-workspace` `connectWorkspace`), so a choice remembered on an empty session — a
`/orquestrar` save, or a confirm whose task never went out — silenced the modal for
every conversation the user opened in that workspace: one answer covering a whole
workspace instead of one chat, and no way left to configure the orchestration there.
The gate now reads the session's own `blank` bit (no turn yet) and asks again in a
conversation with no task, with the dialog pre-filled so one click re-affirms the
choice. The browser's shared last-choice key strips the flag on read as well as on
write. Tests cover both; `docs/DESIGN.md` records the decision.

## 0.2.0

Built from sixteen studies read against the DSH source and public data; the digest, the
decision log (D01 to D14) and every recommendation that was **not** adopted, with the reason,
are in [docs/estudos/](docs/estudos/README.md).

**Why the behavior changed.** DSH deletes the parent's reasoning effort when a child's route
changes, so every re-routed child ran at its route's default (`max` on the deployments this
targets) with the route's full declared output ceiling (131K to 943K tokens). That is what made a fast worker
burn its token budget on one edge case and a slow reasoning model take minutes per turn.

- **Reasoning-effort ceiling and output-token cap for every child the plugin starts.** A
  ceiling, not a setting: it comes from the model's own ladder, leaves a route already below it
  alone, yields to an explicit pick in the dialog, and falls back to the user's pick when the
  model cannot be described. Per-model ceilings are dated rows in `src/models.ts`. Config:
  `effort`, `limits`, `defaults.workerEffort`, `defaults.reviewer.effort`.
- **A worker that stops at its token limit is retried once, one level lower** (same model,
  noted in the banner). `retryOnTokenLimit`.
- **Structured reviewer verdict.** The reviewer reports through DSH's `structured_output` tool;
  the plugin renders the report verdict-first and falls back to a text report. A report that
  contradicts itself is corrected (an approval next to a FAILED or UNVERIFIED criterion becomes
  `NOT_RESOLVED`), softer inconsistencies travel as a `Caution`, and a reply with no valid
  verdict is delivered as `UNREVIEWED` with the reviewer's text as notes. `structuredVerdict`.
- **Clean-context review.** When git shows the working tree changed while the worker ran, the
  reviewer judges the workspace and is not handed the worker's report; it gets the measured
  change list and the test, runner and CI files that changed. When nothing changed (a question,
  a research task) the report goes in as untrusted claims. `reviewerContext`, `workspaceChecks`,
  `sensitivePaths`.
- **Reviewer packet hardening.** Task, facts and report are delimited, the plugin's own tags are
  defanged inside untrusted text, and terminal escapes, control, zero-width and bidirectional
  characters are stripped (also from the `UNREVIEWED` fallback).
- **Persona 2.0.** Authority order, how to find the checks, timeouts and no masked exit codes,
  failure triage against the base commit in a temporary worktree, watching for weakened tests,
  verified behavior over style, stop once the deciding checks ran, hostile terminal output, no
  secrets, sandbox denials that look like other errors.
- **Dialog.** A collapsed reasoning-effort block (recommended level per model, explicit pick
  reaches the host), short dated notes per model, same-model detection across provider spellings
  (`deepseek-v4-pro` on DeepSeek's own API is served by V4.1 Flash), a same-family tip and a
  cost and wait hint for the reviewer. Portuguese and Chinese dictionaries updated.
- **Security model** documented in the READMEs and `docs/DESIGN.md`.
- Contract tests now pin the DSH seams the new behavior depends on (child option resolution,
  `resolveModelInfo`, the structured-output runtime, the catalog's reasoning ladder).
- Validated on DSH 0.1.6-alpha.2 with the three target models: GLM 5.3 (main agent), DeepSeek
  V4.1 Flash (subagent) and MiMo-V2.6-Pro (reviewer); see `docs/validation/README.md`.

Not done, on purpose, with the reasons: read-only reviewer, nonce-signed verdicts, rejecting
patches that touch tests, OS-level isolation, visual review, inline toolbar and presets,
predictive routing, per-request OpenRouter routing, a model-catalog pipeline, a static tool
deny-list, a `max` to `xhigh` rewrite, numeric effort scales and `max_thinking_tokens`. See
`docs/estudos/decisoes.md` (N01 to N16).

## 0.1.0

First release.

- Task-send dialog (DSH primitives and tokens only): subagent model, independent
  reviewer and its model, "do not ask again". Cancel, Escape and close send the
  task as stock DSH.
- `tools/execute` wrapper for `subagent` and `subagent_fork`: model-only mode keeps
  the `continuable` scheduling; reviewer mode runs worker then reviewer and delivers
  only the reviewer's report (worker report under an `UNREVIEWED` banner if the
  review fails).
- Reviewer protocol derived from a deep-research dossier (`docs/pesquisa/`): six
  questions, 120 sources, and a two-phase adversarial verification of its central
  claims (no refutation; three scope corrections applied).
- Per-session choice store (atomic, owner-only), config route behind the DSH trust
  fence, route validation through the live LLM runtime.
- `/orquestrar` command; en, pt and zh dictionaries; works in headless profiles
  through the `defaults` config.
- Validated on DSH 0.1.6-alpha.2 with a real browser and three model families.
  Findings from that run that shaped the release: an un-injected `ctx.remote`
  access crashed the overlay (now resolved lazily; the task still went out as
  stock DSH), the host `Modal` does not contain focus (focus trap added), and a
  `<label for>` hid the picker's current value from screen readers; a smaller
  reviewer model leaked the persona's lettered steps into its report (now
  verdict-first is enforced in the prompt and in the pipeline), and a reviewer
  approved a result whose behavior was wrong because an instruction about how to
  build it took precedence (a failed behavior can no longer be approved).
