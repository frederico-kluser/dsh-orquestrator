# Changelog

## 0.8.1

**The orchestration-skill checkbox is now coupled to the subagent-model switch** (asked right after 0.8.0), and
the stored reasoning-effort level is never lost.

- **Switch off, checkbox off.** With the "Subagent model" switch off the skill checkbox is unchecked and disabled
  (a hint points at the switch): sending adds no token. Turning the switch back on restores the box's last state
  (the remembered answer, or a typed token that locks it). A token already typed by hand is never removed: the hint
  then says the skill applies anyway.
- **The skill preference survives the switch.** It is remembered only when the box was actually answered (switch
  on, not locked); flipping the switch never overwrites it, while the subagent-model choice keeps being stored.
- **The stored effort level is never lost.** While the model's reasoning ladder is unknown (the catalog still
  loading, or failed), a confirm used to drop the stored level to "recommended" silently; now the stored level
  stays selected and is written back. With a stored choice the picker and the effort block come up with the last
  confirmed model and level; with no stored choice the picker starts empty and sending waits for a model.
- Tests: 847 on the Mac mini (+6). The browser checks re-ran green there against freshly built bundles: the skill
  script 132/132 (including the new coupling checks), a subagent's own conversation 10/10, the five earlier phases
  and the README figures, which now show the coupled states. One check of `scripts/e2e/ui-e2e-skill.mjs` that
  contradicted the shipped behavior was fixed; the two harness quirks that remain (turn numbering against a reused
  abandoned session, and the known `open()` flake of `ui-e2e.mjs`) are noted in the validation page.

Compatibility: none on the wire — 0.8.0 and 0.8.1 halves mix fine.

## 0.8.0

**New: a global agent skill, a checkbox for it in the dialog, and the model and the state of every
subagent in the task page's subagent list.**

- **The orchestration skill (`orchestrate-subagents`).** Installing the plugin registers one skill with
  DSH's skill registry (`ctx.skills.register`), so it is available to every task of every session with
  nothing to copy. It teaches the agent that coordinates (never a subagent) to break the task into small
  pieces, start everything that can run together in parallel, keep parallel writers apart in the shared
  working tree (one owner per file, a test baseline first, no commits or dependency changes unless asked),
  never read or write code itself, send subagents to read and report back in a fixed format (`path:line`
  references, facts apart from guesses, a size limit), check every result with a separate verifier subagent
  that is given the requirements and not the author's report, repair in at most two rounds, and report only
  what was proved. Before it was settled its wording was tried on four imagined tasks (a code change, a
  read-only question, a one-line typo, a 40-file migration), and the gaps those exposed became rules. The text lives in
  [`skills/orchestrate-subagents/SKILL.md`](skills/orchestrate-subagents/SKILL.md) and is embedded in
  `lib/index.js` at build time (`pnpm run gen:skill`; a test fails when the generated module and the Markdown
  differ). It is an instruction, not an enforcement: it blocks no tool.
- **A checkbox in the dialog, checked by default.** When it is checked and the send is confirmed, the message
  goes out with the `/orchestrate-subagents` token on a line of its own at the end (at the end, not the start,
  because DSH names a conversation after the first words of its first message), and DSH's own skill gesture injects the skill's
  instructions into that step. Unchecked, or Cancel, Escape and the close button, the message goes out exactly
  as before. The last answer pre-fills the next dialog. The checkbox is shown only when the host half says the
  skill is registered (the configuration route's answer now carries `skill: { name, available }`), so a page
  newer than its host never sends a token nothing expands, and not in a subagent's own conversation (the skill is
  for the agent that coordinates). Typing `/orchestrate-subagents` yourself works in
  every profile, headless included.
- **Which model each subagent runs on, and its state, in the subagent dropdown.** Each row of the dropdown that
  lists a task's subagents now shows the model as a small label (`DeepSeek V4.1 Flash · medium`) and a status
  icon in place of DSH's dot: a spinner while it runs, a check when it is done, a red mark when it failed (an
  error, the token ceiling, a refusal), an amber square when it was stopped, a grey dot when the outcome was
  not recorded. DSH keeps no outcome for a subagent, so the host half now listens to `subagent/start` and
  `subagent/end` (every in-process child emits them, whichever tool started it), keeps a record per child in
  `<stateDir>/subagents.json` and serves it on `GET /dsh-orquestrator/subagents?sessionId=<id>` behind the same
  trust fence. A child that ran before this version has no record: its row shows the model DSH knows for it
  and a grey dot, never an invented "done". The rows are decorated from outside DSH's closed component, by roles
  and structure only, fail-open, and everything is removed when the plugin unloads.
- **Configuration.** `skill: false` does not register the skill (and the dialog shows no checkbox);
  `skill: { modelInvocable: false }` keeps it out of the model's skill catalog so only the token loads it.
- **Tests.** 841 tests with a DSH checkout and 804 without one (what CI runs), typecheck clean; new: a real-dialog
  render suite (jsdom + the real `OrchestratorDialog` and client entry), a real-runtime contract suite (real
  `SkillRegistry`, real `tool-skill`, real continuable epochs), hardened-state-file and two-process tests.
- **Build and tests.** `pnpm run build` now renders `src/skill.generated.ts` first. `jsdom` is a new dev
  dependency, for the tests of the code that decorates DSH's menu. The browser validation scripts gained a web
  profile in `scripts/e2e/setup-isolated-home.sh`.

- **Fixes and hardening found by independent reviews before release.** The dialog queue could wedge every later
  send until a page reload: a configure dialog (`/orquestrar`, the dock chip) for a conversation whose composer
  unmounted while the host was answering became the current dialog and nobody could answer it; a request for a
  conversation without a mounted composer is now cancelled at once, and so are the queued requests of a composer
  that leaves (present since 0.6.0). Two quick sends in one conversation now reach the host in order. A message
  that already carries the token shows the box ticked and locked, since DSH loads the skill anyway. The two state
  files (`sessions.json`, `subagents.json`) are read without following a symlink, refused when they are not
  regular files or exceed 16 MiB, and written through a temp file created exclusively with mode `0600`; two DSH
  processes sharing a state directory no longer drop each other's subagent records. The marks never decorate a
  menu with another conversation's children (two catalogs that fit equally well mark nothing), a host that never
  answers cannot wedge them, and the age of a run is measured with the host's clock.
- **Limits worth knowing.** A first message shorter than five words still carries the token in its automatic
  conversation title (DSH titles a conversation with its first five words). The model on a row is the one DSH
  reports for the child's session, then the one the host recorded when the run started: the host can correct its
  record at the end of a run only for one-shot children (DSH releases a continuable child, which is what the
  standard preset's `subagent` tools start by default, before it announces the end). Orchestrating costs time and
  tokens: see Limits in the README.

Compatibility: the configuration route's answer gains an optional `skill` field, the new read-only route answers
with the host's clock (`now`), and a 0.7 page ignores all of it. A 0.8 page against a 0.7 host offers no
checkbox; its subagent rows show a spinner while DSH says a child runs, a grey dot for the rest and the model DSH
knows, because the route answers 404 once and the page then stops asking (until it is reloaded). Restart `dsh`
after updating and reload the page so both halves match.

## 0.7.0

**New: a status chip under the composer says how subagents are configured in the current
conversation — whether they run on a model of their own, which model, and which reasoning
effort — and opens the dialog on click.** It mounts in the composer's dock
(`conversation.composer.dock`), in the same row as the host's own ambient pills.

- **Off:** `Subagents: same as the main agent`. **Own model:** `Subagents: <model> · <effort>`,
  with the level name from the catalog and `recommended` when no level is stored. An
  effort-only choice shows the main model plus that level.
- **Names come from the composer's own catalog** (the same list the dialog offers); a model
  or level the catalog lacks stands as its raw id.
- **Clicking it opens the same dialog** as `/orquestrar` (configure mode). The chip re-reads
  the stored choice whenever any dialog settles (the gate's or the command's), so it never
  shows a stale answer.
- The dock seam is pinned in the contract tests: when DSH moves `conversation.composer.dock`,
  that test fails first.

Tests: 269.

## 0.6.0

**Fixed: "the modal does not appear for some models or conversations" — the dialog now appears
before every message the user sends, and nothing can skip it.** The gate used to pass some sends
straight through: `/` lines (as "command lines"), messages sent while a turn was running
(queue or steer) and sub-agent conversations. That classification was wrong where it hurt most:
a skill invocation (`/skill ...`) is a **task** that DSH sends verbatim as the prompt — a real
slash command never reaches `prompt` at all — so every task that began with a skill call went
out with no dialog. On the maintainer's own machine 14 of 14 conversations that started with
`/skill` never raised the modal, while 8 of 8 that started with plain text did; because skill
workflows cluster around particular models, it looked like "some models I select" were broken.

- **No send is classified out of the question.** Plain text, `@file` references and `/skill`
  invocations all ask; so do messages typed while a turn runs (queue and steer) and messages
  sent in sub-agent conversations. Only an empty send passes straight through. The message
  waits for the answer, exactly as before.
- **A host route that cannot answer still asks.** `client.load` failing (an unreachable or
  malformed `/dsh-orquestrator/config` — what a host/page version mix produced) used to silence
  the dialog for every task. The dialog now opens pre-filled from the last choice, and a confirm
  says out loud that the choice could not be stored. Only "no composer can render the dialog"
  stays fail-open.
- **The gate attaches as soon as a session exists.** Attaching used to give up after 20 attempts
  over 5 seconds, so a session whose binding materialized later (cold session, heavy workspace,
  reconnect) silently sent every task as stock DSH for the whole conversation. It now keeps
  looking for as long as the composer lives.
- **`/orquestrar` is available in every conversation** too (it used to hide in sub-agent ones).

Tests: 238. The wire contract is unchanged, so a 0.6.0 page works against a 0.5.x host and the
other way round; still restart `dsh` after updating so both halves match.

## 0.5.1

**Fixed: "Could not save the options: config does not match the expected shape".** The dialog could not save
anything when the two halves of the plugin were not the same version. A plugin's host half loads when `dsh` starts and
its browser half when the page loads, so a user who updated to 0.5.0 and refreshed the page without restarting
`dsh web` ran the new dialog against the host still in memory, and that host (0.2 to 0.4) refuses a configuration
without the `reviewer` block 0.5.0 stopped sending: every save came back `422`. The reverse mix failed the same way
(a tab opened before a restart, running the old dialog against a 0.5.0 host, died on the host's answer with "the host
answered a malformed configuration" after the choice had been stored).

- **Both ends keep sending the disabled `reviewer` block** on the wire (`{ enabled: false, model: null, effort: null }`):
  the browser in what it posts, the host in what it answers. 0.5 reads and ignores it and never stores it; 0.2 to 0.4
  accept it. It is one constant and one helper (`LEGACY_REVIEWER`, `toWireConfig` in `src/shared.ts`) and can go once
  nobody runs 0.4.
- **Reproduced before it was fixed, in a real browser, in both directions** (isolated DSH, nothing of yours touched):
  a 0.4.0 host with the 0.5.0 page failed with the exact message above and a `422`; with the 0.5.1 page it saved.
  A 0.5.0 host with a 0.4.0 page failed; a 0.5.1 host with the 0.4.0 page saved.
- **A test fixture holds the 0.4 strict parser** (`test/legacy-wire.ts`) and the unit tests assert that everything the
  current halves put on the wire still passes it, so the compatibility cannot be dropped by accident.
- **The README now says what to do after an update:** restart `dsh web`. Refreshing the page alone updates only the
  browser half.

## 0.5.0

**The independent reviewer is removed. The plugin now does one thing, in code: the model you pick for
subagents, a reasoning-effort ceiling and an output-token cap, on every child DSH starts.** The
start guard of 0.4.0 stays and is now the plugin's only mechanism.

Why ([D16](docs/estudos/decisoes.md)): a reviewer's `APPROVED` was an LLM judging an LLM, so the plugin could
check the report's format and coherence but never its truth, while what the guard enforces is deterministic
and cannot be talked around by the main agent. The reviewer also cost about twice as much and made every
delegation wait for a second model, covered only the two `subagent` tools (never the agents of a workflow,
`ralph`, jobs or teams), and needed a tool wrapper that the guard makes unnecessary: with the wrapper out of
the way, `subagent` (foreground and background) and `subagent_fork` still ran on the picked model, run live.

- **Removed.** The reviewer and everything that served it: `src/pipeline.ts`, `src/reviewer-protocol.ts`,
  `src/workspace.ts` and `src/tool-wrapper.ts` (about 1 250 of the 3 430 lines of the host), the reviewer
  section of the dialog (and its same-model, same-family and cost hints), the model family and lineage helpers
  of `src/models.ts`, the retry after a token-limit stop, and the validation scenarios and runners that
  existed for the reviewer. The `subagent` and `subagent_fork` tools now run entirely stock: the guard puts
  their child on the pick, like any other child.
- **Stays.** The start guard, the planner and its reasoning-effort ceilings, the dialog (one switch for the
  subagent model and a collapsed effort block, shown once a model is chosen), `/orquestrar`, the route and the
  persisted choices. Plugin `inject` is now `['subagents']` only.
- **Nothing you wrote breaks.** A stored choice or a browser's memory with a `reviewer` block is read and the
  block dropped (a choice that only had a reviewer becomes the inert configuration; a stale tab still running
  the 0.4.0 dialog keeps posting without an error). The configuration fields of the reviewer and of the tool
  wrapper (`tools`, `reviewerProvider`, `reviewerContext`, `structuredVerdict`, `workerHandoff`,
  `maxWorkerReportChars`, `retryOnTokenLimit`, `workspaceChecks`, `sensitivePaths`, `defaults.reviewer`,
  `effort.reviewer`, `limits.reviewerMaxTokens`) are ignored with one warning each, never a load error.
- **Two behavior changes to know.** `children: false` now switches the enforcement off altogether (in 0.4.0 the
  tool wrapper kept running); and `defaults.workerEffort` on its own (no model) is now a choice that applies the
  level to children on the main agent's model (it only counted next to a reviewer before).
- **The rest of the log, unchanged.** The model a script names itself is still overruled
  (`children.explicitModel`), a confirmed model that no longer exists still rejects the start with a message
  that says what to do, and the output-token cap is still not durable across DSH's cold resume of a finished
  `continuable` child (N21).
- **Tests.** 253 tests pass with a DSH checkout (228 without one, what CI runs); the suites of the removed code
  went with it, the guard, planner, configuration, store, route and wiring suites were rewritten for the new
  shape, and new ones pin the compatibility above.
- **Validated live** on the three target models (GLM 5.3 main, DeepSeek V4.1 Flash subagents, MiMo-V2.6-Pro only
  where a script names it): eight headless scenarios read back from the DSH session logs and 65 checks through
  the dialog in a real browser, including a real delegation and a real workflow, and a `sessions.json` written
  by 0.4.0 loaded and rewritten in the new shape ([validation](docs/validation/README.md)). Not covered:
  a Sonnet 5.5 main agent and macOS on this build, long workflows, and the paths the README marks as not run
  live.

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
