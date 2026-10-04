# Validation

Everything in this plugin was validated against a real DeepSeek Harness, not only against
mocks. This page states what was run, what it proved, what it found and what it did not
cover: first the **0.5.1** fix (the dialog could not save when the host and the page were different versions), then the
**0.5.0** validation (the reviewer removed, the start guard on its own), then the
**0.4.0** validation of the start guard on the three target models, then the **0.2.0** validation
on the same three models, then the **0.1.0** validation on a Mac mini. The 0.4.0 and older sections
describe versions that still had the independent reviewer, which 0.5.0 removed
([D16](../estudos/decisoes.md)); they are kept as the record of what was run.

## 0.5.1: the dialog saves when the two halves are different versions (2026-10-04)

**What was reported.** Minutes after 0.5.0 was published, on the maintainer's own machine, "Send with these options"
failed with `Could not save the options: config does not match the expected shape`. The live `dsh web` had been started
at 06:35, so its host half (an older plugin version) was in memory; the plugin was updated on disk at 18:39 and the page
refreshed, so the browser loaded the 0.5.0 dialog. 0.2 to 0.4 refuse a configuration without the `reviewer` block that 0.5.0
stopped sending (checked by running the `parseConfig` of 0.3.0 and of 0.4.0, from git, on the 0.5.0 payload: refused with that
exact message, accepted with the block).

**Reproduced in a real browser before it was fixed, in both directions** (isolated DSH home, a profile per mix, the host and
the browser bundle taken from different versions; nothing of the maintainer's session or profile was touched). The check opens
`/orquestrar`, turns the switch on (in the 0.4 dialog: the reviewer switch) and presses Save:

| Mix | Before the fix | After the fix |
| --- | --- | --- |
| 0.4.0 host, 0.5.x page (an update, then a refresh without a restart) | **failed**: `Could not save the options: config does not match the expected shape`, the host answered `422` (0.5.0 page) | **saved**, `200` (0.5.1 page) |
| 0.5.0 host, 0.4.0 page (a tab opened before a restart) | **failed**: `Could not save the options: the host answered a malformed configuration`, although the host had stored the choice (`200`) | **saved**, `200` (0.5.1 host) |

The second row is a defect of the same kind that nobody had reported yet: the old browser refuses an answer without the block.

**The fix.** Both ends keep sending the disabled `reviewer` block (`LEGACY_REVIEWER` and `toWireConfig` in
[`src/shared.ts`](../../src/shared.ts)): the browser in what it posts, the host in what it answers. 0.5 ignores it and never stores it
([D17](../estudos/decisoes.md)). [`test/legacy-wire.ts`](../../test/legacy-wire.ts) is the 0.4 strict parser as a fixture, and the
tests assert that everything the current halves put on the wire still passes it (and that the plain 0.5 shape does not, which is why
the block is there).

**Same-version regression.** On the 0.5.1 build (host and page the same version) the seven browser phases of the 0.5.0 section pass
again, 65 of 65. Tests: 261 of 261 pass with a DSH checkout and 236 of 236 without one (what CI runs). Build: `lib/index.js` sha256
`89cba27edb4f18a2...`, `lib/client.cjs` `40253023ccef8a45...`.

**Not covered.** The maintainer's running `dsh web` was not restarted or modified from here (it hosts the agent session); the fix
reaches it after the plugin is updated and, ideally, `dsh web` is restarted. Halves older than 0.3 were not tried (the 0.5.x wire shape
is the 0.4 one, so they are expected to behave like 0.3 and 0.4, but that was not run). The compatibility has no expiry built in; it can be
removed once nobody runs 0.4.

## 0.5.0: the reviewer removed, the start guard on its own (2026-10-04)

Version 0.5.0 removed the independent reviewer, the `subagent` tool wrapper and the pipeline that
existed for them (about 1 250 of the 3 430 lines of the host). What is left is the start guard, the
planner and the dialog. This validation checks three things: that the guard alone governs every
path, including the `subagent` and `subagent_fork` tools that no code wraps any more; that the dialog
(now one switch and an effort block) works in a real browser; and that what 0.4.0 wrote to disk and to
configuration files keeps working. Same machine, isolation and keys as the [0.4.0 section](#040-the-start-guard-on-the-three-target-models-2026-10-04)
below, and the same models: GLM 5.3 as the main agent, DeepSeek V4.1 Flash for subagents, and
MiMo-V2.6-Pro only as the model a workflow script names itself (W2, W3). Read the sessions back from the
DSH logs with [`run-workflow.sh`](../../scripts/e2e/run-workflow.sh), which fails (exit 3) if any session ran
on another model.

| | |
| --- | --- |
| Build under test | `lib/index.js` sha256 `d6b0211a5f06251c...` (48 kB, from 100+ kB), `lib/client.cjs` `1f8f663607b5c51b...` (two consecutive builds are byte-identical) |
| Tests | 253 of 253 pass with `DSH_CHECKOUT` set (both contract suites included) and 228 of 228 without it (what CI runs); `tsc` clean |
| DSH | 0.1.6-alpha.2 from source (`ddefc45`), isolated `DSH_HOME`, the plugin linked from this working tree |

### Headless: what each agent was asked

Read back from the DSH session logs (`request/header` of each session). Per-run pages in [`runs/`](runs).

| Run | Setup | Main agent | What started |
| --- | --- | --- | --- |
| [**W1**](runs/0.5.0-W1-workflow-governed.md) workflow | `defaults.subagentModel` = DeepSeek V4.1 Flash; a two-agent workflow naming no model | GLM 5.3 `high` | both agents on **DeepSeek V4.1 Flash**, `medium`, **64 000** |
| [**W2**](runs/0.5.0-W2-explicit-override.md) `override` | the script names MiMo for one agent | GLM 5.3 `high` | both on DeepSeek V4.1 Flash, `medium`, 64 000 (the named route dropped) |
| [**W3**](runs/0.5.0-W3-explicit-keep.md) `keep` | `children: { explicitModel: keep }`, same script | GLM 5.3 `high` | MiMo-V2.6-Pro at `low` with 64 000; the other on DeepSeek V4.1 Flash `medium` 64 000 |
| [**W4**](runs/0.5.0-W4-guard-off.md) the switch | `children: false` | GLM 5.3 `high` | both back on GLM 5.3 `high`, no cap |
| [**W5**](runs/0.5.0-W5-background-continuable.md) `subagent`, background | the standard preset's `continuable` tool, **nothing wraps it** | GLM 5.3 `high` | one child on DeepSeek V4.1 Flash, `medium`, 64 000 |
| [**W6**](runs/0.5.0-W6-confirmed-model-gone.md) dead model, workflow | `defaults.subagentModel` = a model the runtime no longer knows | GLM 5.3 `high` | **no child session**; the workflow fails at once with a message that names the model and says what to do |
| [**W7**](runs/0.5.0-W7-subagent-tool-model-gone.md) dead model, tool | same, through the `subagent` tool | GLM 5.3 `high` | **no child session**; the tool result is the same message |
| [**W8**](runs/0.5.0-W8-fork-governed.md) `subagent_fork` | the fork provider (the child inherits the parent's conversation) | GLM 5.3 `high` | one child on DeepSeek V4.1 Flash, `medium`, 64 000 |

Before these, three smaller runs checked the central claim in isolation: with the delegation-tool list
of the 0.4 wrapper pointed at a tool that does not exist, so that the wrapper could never match, the
`subagent` tool (foreground and background) and `subagent_fork` still ran on DeepSeek V4.1 Flash at `medium`
with 64 000. The guard alone does the job; the wrapper was only ever needed for the reviewer.

### The dialog, in a real browser

[`ui-e2e.mjs`](../../scripts/e2e/ui-e2e.mjs) drives Google Chrome (headless, `playwright-core`) against a real
`dsh web` on the isolated home. 65 of 65 checks pass, in seven phases:

| Phase | Checks | What it proves |
| --- | ---: | --- |
| `cancel` | 11 | A new task raises the dialog (one switch, off, no "do not ask again" checkbox, no mention of a reviewer); Escape sends the task as stock DSH and writes `config: null` |
| `small` | 3 | At 1024 x 600 with the model chosen and the effort block open, the dialog fits and the primary action is inside the viewport |
| `light` | 5 | Light theme; Tab never leaves the dialog; Escape closes an open menu first and the dialog second |
| `command` | 7 | `/orquestrar` opens the configure dialog; Save stores the model; the next task asks again, pre-filled |
| `effort` | 16 | No effort block until a model is chosen; recommended levels (DeepSeek `medium`, GLM 5.3 `high`, MiMo `low`); the model notes; an explicit `high` reaches the wire (`{ version, subagentModel, workerEffort }` and nothing about a reviewer) and the dialog reopens with it |
| `confirm` | 13 | Choose DeepSeek V4.1 Flash, send, and read the child back from the logs: one subagent on DeepSeek V4.1 Flash, `medium`, 64 000, finished, answer `42` in the transcript |
| `workflow` | 10 | The choice stored through the route (not a `defaults` config) governs a real workflow: two agents on DeepSeek V4.1 Flash, `medium`, 64 000, both completed |

Screenshots: [empty dialog](screenshots/0.5.0-cancel-02-modal.png), [model chosen](screenshots/0.5.0-confirm-01-modal-filled.png),
[effort block open](screenshots/0.5.0-effort-04-explicit-high.png), [light theme](screenshots/0.5.0-light-01-modal-light.png),
[600 px high](screenshots/0.5.0-small-01-open-600px.png), [workflow task](screenshots/0.5.0-workflow-01-modal-subagent-model.png).

### What 0.4.0 left on disk and in configuration

The isolated web profile's `state-web/sessions.json` held choices written by 0.4.0, each with a `reviewer`
block (one of them a DeepSeek V4.1 Flash choice at `high` with a MiMo reviewer). The 0.5.0 server loaded the
file, and after its next saves the same sessions were rewritten with exactly `version`, `subagentModel` and
`workerEffort`: the file holds eight entries and none has a reviewer block. Unit and integration tests cover the rest: a stored choice
with a reviewer block, a reviewer-only choice (it becomes the inert configuration), a stale browser tab still
posting the 0.4.0 shape (accepted, the block dropped), and a 0.4.0 patch file (every removed field ignored with
one warning, never a load error).

### What this did not cover

- **No Sonnet 5.5 as the main agent, and no macOS, on 0.5.0.** The session that exposed the original bug ran
  Claude Sonnet 5.5; here the main agent is GLM 5.3. The guard reads the main agent's route only to complete a
  route a caller named by model alone and as the baseline of an effort-only choice, so the fix does not depend on
  it. (The 0.4.0 build was run on a Mac mini with Sonnet 5.5 as the main agent and passed on the same path; that
  run is not part of this page.)
- **One sample per condition**, small tasks, a few seconds each. This shows the mechanism, not behavior on
  a long workflow of dozens of agents on real work (provider rate limits, an agent hitting the 64 000-token cap
  and, with no retry any more, failing).
- No live run used a one-shot background job, `ralph`, an agent team, the SDK provider or
  `codex` / `claude-code` / ACP; those rows of the README follow from the doors they use, which the contract tests pin.
- The output-token cap is still lost when DSH resumes a finished `continuable` child (N21).
- **Nothing checks what a subagent produces any more.** That is the decision, not an omission ([D16](../estudos/decisoes.md)).

## 0.4.0: the start guard, on the three target models (2026-10-04)

The bug behind this release was found in a real session, then reproduced, closed and checked for
regressions on an isolated DSH, again with only the three target models.
[`run-workflow.sh`](../../scripts/e2e/run-workflow.sh) and `run-trio.sh` (removed in 0.5.0 with the reviewer)
read the sessions back from the DSH logs and fail (exit 3) if any session ran on another model.

### The incident

A session in a real project had confirmed "subagents on DeepSeek V4.1 Flash" in the dialog (the plugin's
`sessions.json` held it, written at 10:46:39, 94 ms before the session's first model request). The main
agent (Claude Sonnet 5.5 at `max`) then called the `workflow` tool once and 34 agents followed (13 executors,
11 verifiers, 9 corrections, 1 probe). Read back from the session logs, every one of the 3 900 assistant
messages of that session and its children came from `azure-opencode-claude/claude-sonnet-5-5`, each child
at `max` with 128 000 output tokens, about 7.2 million output tokens and 1.26 billion cache-read tokens
in the children alone, none from DeepSeek. The plugin had done what it was built to do; the workflow does not
call a delegation tool, so it never ran. Root cause and decision: [D15](../estudos/decisoes.md).

### Roles, machine, build

| Role | Model | Route |
| --- | --- | --- |
| Main agent | GLM 5.3, reasoning `high` | `openrouter/z-ai/glm-5.3` |
| Subagent (worker) | DeepSeek V4.1 Flash | `azure-opencode/DeepSeek-V4.1-Flash` |
| Reviewer | MiMo-V2.6-Pro | `openrouter-extra/xiaomi/mimo-v2.6-pro` |

The session that exposed the bug ran Claude Sonnet 5.5 as its main agent. That model never ran here (live runs
use the three models only). The guard reads the main agent's route only to complete a route a caller named by
model alone and as the baseline of a reviewer-only choice, so the fix does not depend on it, but it was not run
under a Sonnet main agent.

| | |
| --- | --- |
| Machine | This Linux workstation (CachyOS) |
| DSH | 0.1.6-alpha.2 from source (`ddefc45`). Isolated `DSH_HOME` with three profiles: `headless` (this build, `link:`), `before` (the 0.3.0 build, commit `487e720`) and `web` (this build, for the browser phases, on `--port 0`) |
| Isolation | The DSH the user was working in (port 3080, its running session) was never touched: no restart, no profile edit, no file of `~/.dsh` read except one copy of `settings.yaml` (variable names, no key values) |
| Keys | [`with-keys.sh`](../../scripts/e2e/with-keys.sh): only `OPENROUTER_API_KEY` and `AZURE_OPENCODE_API_KEY` reach the agents; every other secret of the user's environment is removed first |
| Toolchain | Node 24.19.0, pnpm 11.7.0 |
| Build under test | `lib/index.js` sha256 `a6f5d8f77852d82c...`, `lib/client.cjs` `b63b0e348e2e8721...` (two consecutive builds are byte-identical) |
| Tests | 388 of 388 pass with `DSH_CHECKOUT` set (both contract suites included) and 357 of 357 without it (what CI runs); `tsc` clean; `check:lib` clean. Audited by mutation: 295 single-line mutants of the guard and the code around it, 283 killed by the suite and 12 equivalent (they cannot change behavior) |
| Browser | Google Chrome (system), headless, driven by `playwright-core` |

### What each agent was asked

Read back from the DSH session logs (`request/header` of each session). Per-run pages in [`runs/`](runs).

| Run | Plugin and setup | Main agent | The two agents the workflow (or the tool) started |
| --- | --- | --- | --- |
| [**W0**](runs/0.4.0-W0-before-bug.md) the bug, reproduced | 0.3.0; `defaults.subagentModel` = DeepSeek V4.1 Flash, reviewer MiMo; a two-agent workflow naming no model | GLM 5.3 `high` | both on **GLM 5.3** at `high`, no token cap |
| [**W1**](runs/0.4.0-W1-workflow-governed.md) closed | 0.4.0, same task | GLM 5.3 `high` | both on **DeepSeek V4.1 Flash**, `medium`, **64 000**; no reviewer started for them |
| [**W2**](runs/0.4.0-W2-explicit-override.md) `override` | the script names MiMo for one agent | GLM 5.3 `high` | both on DeepSeek V4.1 Flash, `medium`, 64 000 (the named route dropped) |
| [**W3**](runs/0.4.0-W3-explicit-keep.md) `keep` | `children: { explicitModel: keep }`, same script | GLM 5.3 `high` | MiMo-V2.6-Pro at `low` with 64 000 (its ceiling, below the route's `max`/131 072); the other on DeepSeek V4.1 Flash `medium` 64 000 |
| [**W4**](runs/0.4.0-W4-guard-off.md) the switch | `children: false` | GLM 5.3 `high` | both back on GLM 5.3 `high`, no cap |
| [**W5**](runs/0.4.0-W5-background-continuable.md) not a workflow | the `subagent` tool in the background (`continuable`, the preset's default), model only | GLM 5.3 `high` | one child on DeepSeek V4.1 Flash `medium` 64 000, planned once |
| [**W6**](runs/0.4.0-W6-confirmed-model-gone.md) the model is gone | `defaults.subagentModel` = a model the runtime does not know (never called) | GLM 5.3 `high` | none: the workflow fails at once with `the subagent model azure-opencode/Retired-Model-9 cannot be used (...). Open /orquestrar to pick another model` |
| [**W7**](runs/0.4.0-W7-subagent-tool-model-gone.md) the same, through the tool | the `subagent` tool | GLM 5.3 `high` | none: the tool result is the same message, not a bare `subagent run failed` |
| [**T3**](runs/0.4.0-T3-readonly-claims.md) regression | the `subagent` tool, foreground, reviewer on | GLM 5.3 `high` | worker DeepSeek V4.1 Flash `medium` 64 000; reviewer MiMo-V2.6-Pro `medium` 32 000 with `structured_output`; verdict `APPROVED` delivered to the main agent |

### The browser (68 checks, real Chrome against a real `dsh web`)

| Phase | Checks | What it covers |
| --- | ---: | --- |
| `small` | 3/3 | the dialog with both sections open, now with the two scope lines, still fits 1024 x 600 (556 px, [screenshot](screenshots/0.4.0-small-01-both-open-600px.png)) |
| `effort` | 19/19 | recommended levels, explicit pick on the wire, model notes, same-model and same-family tips |
| `light` | 5/5 | light theme, focus trap, Escape handling; the new "applies to every subagent, including the agents a workflow starts" line is on the page |
| `cancel` | 11/11 | Escape sends the task as stock; the stored choice is cleared |
| `command` | 7/7 | `/orquestrar` opens the configure dialog; Save persists; the next task asks again, pre-filled |
| `confirm` | 13/13 | the full path through the dialog: GLM main, DeepSeek worker, MiMo reviewer, a reviewed delivery |
| `workflow` | 10/10 | **the user's own path**: the choice made in the dialog ([screenshot](screenshots/0.4.0-workflow-01-modal-subagent-model.png); stored through the route, not a `defaults` config) governs the two agents of a workflow the main agent starts: both on DeepSeek V4.1 Flash, `medium`, 64 000, both finished |

### What it showed

1. **The bug is real and reproduced on the unmodified 0.3.0** (W0), with the plugin configured exactly as the user
   had it. The agents of a workflow, `ralph`, a one-shot job and an agent team never pass through the tool the
   plugin wrapped.
2. **The guard closes it where the plugin has the means to: at the two doors every child passes through** (W1 to W3, W5,
   `workflow` browser phase). The effort ceiling and the token cap travel with the model: DeepSeek V4.1 Flash on a
   route whose own default is `max` with 384 000 ran at `medium` with 64 000.
3. **The semantics are the documented ones**: the user's pick wins over a model a script names (W2), `keep` lets it
   stand under the ceilings (W3), `children: false` is the old behavior (W4).
4. **The `subagent` tool and the reviewer are unchanged** (T3, `confirm`): the pipeline's own worker and reviewer are
   not planned a second time, which is what the request mark is for (the reviewer stays on MiMo, not on the worker's model).
5. **A dead confirmed model is loud** (W6, W7), never forced onto the child or silently replaced.

### What it found about the plugin and about the validation

* Two independent reviews of the change (an adversarial one against the DSH source and the real runtime, and a
  mutation audit of the tests) found and fixed: the "already planned" mark was the identity of one object (now it also
  survives a copy); a child on the parent's own route inherits the parent's effort and the parent's token limit is handed
  down on every route, which the planner assumed otherwise; a caller's effort that the model does not offer was spread back
  in by the merge; a dead stored model was forced onto every workflow agent; 55 real test gaps (the first mutation round
  killed 142 of 206 mutants, 68.9%; the final tree, with the tests that round asked for and the 128 new ones in all, kills
  283 of 295, and the 12 that live are equivalent mutants). The contract tests were hardened the same way (a simulated DSH
  drift now fails them: a second door through `getProvider`, a new hook, extra workflow `agentOptions` keys, a built resolver
  that stops clearing the effort). One limit is documented, not fixed: the token cap does not survive DSH's cold resume of
  a finished `continuable` child ([N21](../estudos/decisoes.md)).
* The validation itself needed three corrections worth keeping: a `settings.yaml` rewritten through a YAML library turns
  a reasoning ladder's `off:` key into `false:` and DSH then registers no LLM adapter (`NO_ADAPTER`), so the setup
  script copies it verbatim and edits two blocks as text; the foreground command runner has a 600 s limit and the MiMo
  reviewer took 504 s in one run and 91 s in the next, so T3 runs in the background; two scenarios run at the same time
  hand each other's `cordis.patch.yml` to the DSH that boots second (an early T3 ran on W6's dead model that way and its
  exit code 3 is the model guard doing its job), so one script at a time. The browser script's `cancel` and `command`
  phases still expected the "do not ask again" checkbox that 0.3.0 removed; they check the current behavior now.

### What it did not cover

* **Claude Sonnet 5.5 as the main agent** (the rule for live runs is the three models). The main agent's route only
  matters as described above.
* **`ralph`, agent teams, a one-shot background `subagent` job, the SDK provider and `codex` / `claude-code` / ACP** were
  not run live. They are covered by construction (the doors they use are pinned against the DSH source and the guard is
  exercised on the built `SubagentRuntime`), not by a run.
* **The browser path was run with a workflow that names no model and with the default `override`**; `keep` was run
  headless only.
* **One sample per condition**, a task small enough that no agent ran for long, Linux only.
* **The token cap on a resumed child** (above), and any cold resume of a continuable child.
* The long-running real workflow of the incident was not replayed: the guard was validated on small workflows, the
  agents' behavior under a 64 000-token cap on large tasks was not measured.

## 0.2.0: the three target models (2026-10-03)

Only three models ever ran, in the roles the studies defined for them.
`scripts/e2e/run-trio.sh` (removed in 0.5.0 with the reviewer) enforces it: after every run it
reads the sessions back from the DSH logs and fails (exit 3) if any session ran on another model.
Exploratory runs made earlier on other models were discarded and are not cited.

| Role | Model | Route |
| --- | --- | --- |
| Main agent | GLM 5.3, reasoning `high` | `openrouter/z-ai/glm-5.3` |
| Subagent (worker) | DeepSeek V4.1 Flash | `azure-opencode/DeepSeek-V4.1-Flash` |
| Reviewer | MiMo-V2.6-Pro | `openrouter-extra/xiaomi/mimo-v2.6-pro` |

| | |
| --- | --- |
| Machine | This Linux workstation (CachyOS), not the Mac mini |
| DSH | 0.1.6-alpha.2 from source (`ddefc45`); the plugin installed with `link:` into an isolated `DSH_HOME`; web server on `--port 0` |
| Toolchain | Node 24.19.0, pnpm 11.7.0 |
| Build under test | `lib/index.js` sha256 `e0e707bfaceed781...`, `lib/client.cjs` `e6edd06e36c44b33...`. Two consecutive builds are byte-identical, so the committed `lib/` is reproducible. |
| Tests | 259 of 259 pass with `DSH_CHECKOUT` set, including 17 DSH-source contract tests |
| Browser | Google Chrome (system), headless, driven by `playwright-core` |
| Keys | From the launching shell's environment; never written to a file or a report |

### What each model was asked

Read back from the DSH session logs (`request/header` of each session), not from the plugin's
own logs. The main agent is never touched by the plugin, so it has no output ceiling in its header.

| Run | Worker: effort, max output, time, tool calls | Reviewer: effort, max output, time, tool calls | Review packet | Verdict | Total |
| --- | --- | --- | --- | --- | ---: |
| [**T1**](runs/T1-spec-rules.md) seven easy-to-miss rules | `medium`, 64 000, 28 s, 7 | `medium`, 32 000, 169 s, 16 | facts, report withheld | `APPROVED` | 255 s |
| [**T1, first run**](runs/T1-first-build.md) | `medium`, 64 000, 55 s, 13 | `medium`, 32 000, 253 s, 12 | facts, report withheld | `NOT_RESOLVED` (see below) | 333 s |
| [**T2**](runs/T2-conflict.md) conflicting requirements | `medium`, 64 000, 16 s, 7 | `medium`, 32 000, 70 s, 11 | facts, report withheld | `NOT_RESOLVED` | 112 s |
| [**T3**](runs/T3-readonly-claims.md) read-only question | `medium`, 64 000, 19 s, 8 | `medium`, 32 000, 75 s, 8 | facts, report as untrusted claims | `APPROVED` | 135 s |
| [**T4**](runs/T4-policy-off.md) T1 with ceilings **off** | `max`, 384 000, 63 s, 18 | `max`, 131 072, 128 s, 13 | facts, report withheld | `APPROVED` | 259 s |
| **confirm** (browser, see below) | `medium`, 64 000, 15 s, 5 | `medium`, 32 000, 42 s, 10 | facts, report withheld | `APPROVED` | 185 s |

### What it showed

1. **The ceiling reaches the wire, and without it DSH runs the child at `max`.** T1 to T3 and
   the browser run: DeepSeek V4.1 Flash at `medium` with 64 000 output tokens and MiMo at `medium`
   with 32 000, on routes whose own default is `max` with 384 000 and 131 072. T4 (`effort: false`,
   `limits: false`) is the same task with the plugin out of the way: both children ran at `max` with
   those declared ceilings. That is the root cause in `docs/estudos/sintese.md`, measured instead of read from code.
2. **No speed-up was measured on this small task, and none is claimed.** T1 took 255 s and T4
   259 s end to end; the worker was faster at `medium` (28 s against 63 s, 7 tool calls against
   18), the reviewer was slower (169 s against 128 s). One sample per condition and a task that does not
   provoke a runaway: the ceiling is a guard on the tail (a fast model deliberating one edge case
   until its budget ends, a slow one needing minutes per turn), which these runs did not exercise.
3. **The reviewer found real problems from a clean context.**
   * *T1, first run:* GLM 5.3 wrote `parseDuration('1d 2h 30m 45s') -> 97545` into **its own delegation prompt**
     (the unit table gives 95445). MiMo returned `NOT_RESOLVED`, verified everything else (16 of 16 tests) and put
     the contradiction in the verdict line for the main agent to decide.
   * *T2:* the two requirements cannot both hold. `NOT_RESOLVED`, with both requirements named in the summary
     (persona rule 11), and a failing `node --test` it ran itself.
   * *T1:* MiMo wrote its own 62-assertion conformance check and a mutation check to confirm the worker's tests can
     actually fail (persona rule 6), then approved and changed nothing.
4. **`reviewerContext: auto` chose the right mode in both directions.** Where files changed (T1, T2, T4) the packet
   carried the measured change list, flagged the test file and withheld the worker's report. In T3 nothing changed
   (`git status` clean afterwards), so the worker's answer went in as untrusted claims and the reviewer verified it by
   reading the source and running `parseConfig`.
5. **The structured report works with all three roles on a real DSH.** The reviewer session carries DSH's
   `structured_output` tool, calls it, and the main agent receives the plugin's verdict-first rendering under the
   `Reviewed delivery` banner. No run needed the text fallback.
6. **The main agent at `max` is outside the plugin's reach.** A first attempt with GLM 5.3 as main agent at `max` gave no
   first tool call in 8.4 minutes and was stopped; at `high` the same task was delegated in about 10 seconds. The plugin
   never changes the main agent's options (documented), so this is a configuration note, in line with study E01, which
   recommends `high` for GLM 5.3.
7. **Runner lessons.** The browser GUI creates its sessions in the last workspace the DSH home registered, so a headless run
   and a browser run started together share one working tree (it corrupted a T4 attempt, which was discarded and
   rerun alone). `session-config.mjs` now filters by the run's main session.

### The browser, on the same three models

Against a real `dsh web` and the main agent GLM 5.3. Reports: [`reports/0.2.0/`](reports/0.2.0).

| Phase | Checks |
| --- | --- |
| `effort` (19) | No effort block while both switches are off; it appears collapsed with "Recommended level for each model". DeepSeek V4.1 Flash shows "Recommended: Medium" (its route defaults to `max`), GLM 5.3 as reviewer "Recommended: Low" (its ladder is low, high, max) with the text-only note, MiMo-V2.6-Pro "Recommended: Medium" with the slow-at-high-effort note. The reviewer cost hint. The same-model tip when worker and reviewer are DeepSeek V4.1 Flash, including across two routes (Azure and DeepSeek's own API). An explicit "High" for the subagent marks the block as customized and reaches the host with 200 (`workerEffort: "high"`, reviewer effort `null`). |
| `confirm` (13) | Models picked from the live catalog (DeepSeek V4.1 Flash, MiMo-V2.6-Pro); the choice is stored (200); the main agent runs the task and receives a `Reviewed delivery` result with a verdict. |
| `cancel` (11) | The modal appears on a new task; Escape sends it as stock DSH and stores `null`. |
| `command` (6) | `/orquestrar` opens the dialog in configure mode; Save persists; the next task is sent without a modal. |
| `light` (5) | Light theme; Tab never leaves the dialog; Escape closes an open menu first. |
| `small` (3) | At 1024x600 with both sections open the dialog fits and its actions stay visible. |

| Subagent and reviewer chosen | Effort, explicit pick | Delivered to the main agent |
| --- | --- | --- |
| ![](screenshots/0.2.0-confirm-01-modal-filled.png) | ![](screenshots/0.2.0-effort-03-explicit-high.png) | ![](screenshots/0.2.0-confirm-03-delivered.png) |

### Not covered

* A token-limit stop was never provoked on a real model, so the one-level-lower retry is covered by unit tests only.
* No model skipped the structured tool, so the verdict-first text fallback is covered by unit tests only.
* Provider `fork`, the TUI and SDK profiles, and macOS (the 0.2.0 runs were on Linux).
* One sample per condition: the timings above illustrate, they do not measure.
* DeepSeek's own API (`deepseek-official`) was not called by any run; Azure served DeepSeek V4.1 Flash.

## 0.1.0 on a Mac mini (2026-09-30 to 2026-10-02)

### Environment

| | |
| --- | --- |
| Machine | Mac mini M1, macOS 15.7.9, reached over SSH |
| DSH | 0.1.6-alpha.2 from source (`ddefc45-dirty`), the plugin installed by `link:` and, separately, by `github:frederico-kluser/dsh-orquestrator` |
| Toolchain | Node 24.19.0, pnpm 11.23.0 |
| Isolation | A separate `DSH_HOME` (`/Volumes/Ext2TB/dsh-orq-validation/home`); the web server on `--port 0`. The DSH already serving port 3080 was never touched. |
| Models | main `openrouter-extra/xiaomi/mimo-v2.6-pro` (the machine's default); subagent `openrouter/google/gemini-3.8-flash`; reviewer `azure-opencode-claude/claude-haiku-4-5`. Three model families. |
| Browser | Google Chrome (system), headless, driven by `playwright-core` |

The scripts are in [`scripts/e2e/`](../../scripts/e2e). The per-phase JSON reports are in
[`reports/`](reports), the screenshots in [`screenshots/`](screenshots), and one
Markdown summary per headless run in [`runs/`](runs).

### What was checked

#### 1. Build and tests on the target machine

`git clone` from GitHub, `pnpm install --frozen-lockfile`, `pnpm run build`, then the
whole suite with `DSH_CHECKOUT` pointing at that machine's DSH source.

- The committed `lib/` is byte-identical to a fresh build on a second machine
  (`git status` clean after building).
- Unit and integration tests pass, and the contract tests pin the DSH internals the
  plugin depends on: the `tools/execute` waterfall and its result re-validation, the
  subagent tool's output schema, `SubagentRuntime` (`start`, `startContinuable`,
  `resolveMaxDepth`, `getProvider`), `SessionFace.prompt`, the composer overlay slot,
  the primitives and their props, and the shell's module table.

#### 2. Real delegation, headless ([`runs/`](runs))

Main agent `openrouter-extra/xiaomi/mimo-v2.6-pro`, worker `openrouter/google/gemini-3.8-flash`,
reviewer `azure-opencode-claude/claude-haiku-4-5` (three families). Each run is a fresh
git workspace and a real `dsh --profile headless` process.

| Run | Outcome |
| --- | --- |
| [**A**](runs/A-reviewed.md) worker + reviewer | 396 s. The main agent's `subagent` call was intercepted at the root context; a worker child ran on Gemini and a reviewer child on Haiku; the tool result the main agent received was the **reviewer's** report under `Reviewed delivery ... [verdict: APPROVED]`, and the worker's own report did not reach it. Re-running the tests independently in the workspace: 6 of 6 pass. |
| [**B**](runs/B-model-only.md) model only | 266 s. Only the child's model changed (Gemini); the main agent received the worker's own result, as stock. |
| [**B2**](runs/B2-background.md) model only, background | 162 s. The `continuable` path: the main agent got `started subagent ...`, the child ran on Gemini, and the main agent later reported the file's content. |
| [**C**](runs/C-stock.md) stock | 67 s. Plugin loaded with an empty config: the child ran on the **main agent's** model and delegation behaved exactly like stock DSH. |
| [**D**](runs/D-reviewer-fixes.md) seven easy-to-miss rules | 612 s. The worker met them all; the reviewer verified and returned `APPROVED` without inventing defects. |
| [**D2**](runs/D2-final.md) same task | 658 s. The worker ran out of tokens; the plugin reported it as the stock tool does (`subagent run hit its token limit ...`) and did **not** start a reviewer. |
| [**E**](runs/E-unreviewed.md) reviewer cannot start | 124 s. The main agent received `WARNING - UNREVIEWED: the independent review did not complete ...` followed by the worker's raw report. |
| [**F**](runs/F-planted-defect.md) planted defect | 381 s. The request pushed the worker into a wrong `fizzbuzz` (15 gives `Fizz`) and forbade tests. The reviewer ran `fizzbuzz(15)`, saw the wrong output, named the contradiction, and still returned `APPROVED` because the request said the build style took precedence. **A real defect in the protocol, fixed (finding 7).** |
| [**F2**](runs/F2-conflict-rule.md) same task, new rule | 159 s. `VERDICT: APPROVED_WITH_FIXES`: the reviewer reordered the chain to 15, 3, 5 and reported the departure from the style rule. The main agent received the reviewer's report. |

#### 3. The dialog, in a real browser against the real web server

| Phase | Checks |
| --- | --- |
| `cancel` (11) | The modal appears on a new task from the composer; title, description, task preview, two switches off, checkbox unchecked, primary action focused; **Escape sends the task as stock DSH** and stores `null`; no page errors. |
| `confirm` (13) | Choose the subagent model and the reviewer model from the composer's own catalog; confirm is disabled until a model is chosen; the choice is stored (200); the main agent runs the task and receives a `Reviewed delivery` result with a verdict. |
| `light` (5) | Light theme; Tab never leaves the dialog; Escape closes an open menu first and the dialog on the next press. |
| `command` (6) | `/orquestrar` opens the dialog in configure mode; Save persists reviewer and "do not ask again"; the next task is sent without a modal. |
| `small` (3) | At 1024x600 with both sections open the dialog fits, its body scrolls, and the actions stay visible. |

| Dark, empty | Dark, filled | Delivered to the main agent |
| --- | --- | --- |
| ![](screenshots/cancel-modal-dark.png) | ![](screenshots/confirm-modal-filled.png) | ![](screenshots/confirm-delivered.png) |

#### 4. UX self-audit

Applied the uxuiprinciples framework (no API key, so from internal knowledge and
without citations; a self-assessment, not an independent audit):
[before](uxui-audit-before.json) scored 80 (good), [after](uxui-audit-after.json) scored 94
(excellent) once the two warnings were fixed.

### What validation found, and what changed

Each of these was invisible to the mocks and surfaced only on the real DSH:

1. **`cannot get property "remote" without inject`.** The catalog loader touched
   `ctx.remote`, which Cordis refuses for a plugin that did not inject it. DSH isolated
   the crash (`slot entry crashed in 'conversation.input.overlay'`) and the task went
   out as stock DSH, which confirmed the fail-open design, but the modal never showed.
   Sources are now resolvers evaluated inside the loader's error handling, using `ctx.get`.
2. **No focus containment.** The host `Modal` declares `aria-modal` but does not trap
   Tab; every Tab left the dialog. A small focus trap (paused while a menu portal owns
   the keyboard) fixes it without touching the host.
3. **The picker's current value was hidden from screen readers.** A `<label for>` named
   the button by its label alone. The button is now named by label plus value
   (`aria-labelledby`).
4. **Reviewer format drift on a smaller model.** Haiku echoed the persona's lettered
   procedure steps ("D.", "E.") as headings and narrated its analysis before the
   report. The persona no longer labels steps and forbids working notes in the final
   message, and the pipeline drops a preamble before the verdict line when a full report
   follows it.
5. **A worker went digging in DSH's storage for reviewer traces.** The handoff contract
   mentioned the reviewer; it now says only that the message "will be checked against the
   workspace by someone else".
6. **Copy.** Double colons ("model: Xiaomi: MiMo") and a switch whose ON meaning was
   only discoverable by toggling.
7. **A reviewer approved a result whose behavior was wrong** (scenario F). Instruction
   priority explained the failure, and the caveat sat in the middle of the report where
   a top-only reader would miss it. The persona now says a conflict between requirements
   is not a pass: a failed behavior is a FAILED criterion and cannot be approved; the
   reviewer fixes it minimally and reports the departure, or returns `NOT_RESOLVED` with
   the conflict named in the verdict line. Scenario F2 re-ran it on the new build.
8. **Runner bugs, not plugin bugs.** An empty profile overlay is not a valid patch (it
   must be `[]`); `git pull` aborted over files copied by hand; a burst of 36 parallel
   research verifiers exhausted the search API's key pool (see the dossier, section 8).

### Revalidation after the search-key reset (2026-10-02)

The research verification had been left incomplete because the search API keys were
exhausted. After the keys were reset, everything done on the Mac mini was checked again
from a clean state, and the research step was finished (see the dossier, sections 3, 4 and 8).

| Check | Result |
| --- | --- |
| Machine doctor (G1-G8: SSH key, sudo, root SSH, TCC, sshd, volume) | all green |
| Sync before checking | this machine, GitHub and the Mac mini all at `89b3408` (0 ahead, 0 behind) |
| Mac mini: `pnpm install --frozen-lockfile`, `pnpm run build` | `git status` clean afterwards, so the committed `lib/` is reproducible; `check-lib` passes |
| Mac mini: full suite with `DSH_CHECKOUT` | 136 of 136 pass, including the 11 DSH-source contract tests |
| Install straight from GitHub (`pnpm add github:frederico-kluser/dsh-orquestrator`) | `lib/index.js` and `lib/client.cjs` are byte-identical to the committed ones (sha256 `3eef6576...` and `c1f85117...`) |
| Isolated DSH home after deleting the credentials copy | still boots and answers (keys come from the environment) |
| Browser phases against the real web server, [`reports/revalidation/`](reports/revalidation) | cancel 11, light 5, command 6, small 3, confirm 13: 38 of 38, no page errors |
| Headless run on the final build ([`runs/A2-final.md`](runs/A2-final.md)) | worker on Gemini, reviewer on Haiku, `Reviewed delivery ... [verdict: APPROVED]`, verdict-first report, 327 s |

### Not covered

- Profiles other than `web` and `headless` (TUI, SDK).
- One-shot `subagent` background jobs are not orchestrated by design.
- Only macOS/arm64 was exercised end to end; the code has no platform-specific paths.
- A reviewer that repairs is measured on the runs above, not on a benchmark. The
  research dossier says why no published study settles that question.
