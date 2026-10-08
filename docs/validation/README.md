# Validation

Everything in this plugin was validated against a real DeepSeek Harness, not only against
mocks. This page states what was run, what it proved, what it found and what it did not
cover: first the **0.8.3** fixes (the score per effort, a legible select, Cancel that aborts), then the **0.8.2** rebuild of the dialog's model area (effort select, capability strip, the checkbox un-gated), then the **0.8.1** follow-up (the skill checkbox coupled to the subagent-model switch), then the **0.8.0**
validation (the orchestration skill, its dialog checkbox and the model/state marks on the subagent list; every run on
the project's Mac mini test host), then the **0.5.1** fix (the dialog could not save when the host and the page were
different versions), then the
**0.4.0** validation of the start guard on the three target models, then the **0.2.0** validation
on the same three models, then the **0.1.0** validation on a Mac mini. The 0.4.0 and older sections
describe versions that still had the independent reviewer, which 0.5.0 removed
([D16](../estudos/decisoes.md)); they are kept as the record of what was run.

## 0.8.3: the score per effort, a legible select, and Cancel that aborts (2026-10-08)

**What changed.** (a) The score badge re-resolves when the effort select changes: Terminal-Bench 4 shows the accuracy of the chosen level when the leaderboard has it, else the value at the model's best level; the OpenRouter intelligence index is one scalar per model (verified across all 469 catalog models), so an Intelligence badge is constant — the "intelligence at max" fallback the user asked for. (b) The effort select paints its own background/text/border/option colors from DSH tokens (it used to render white-on-white) with `color-scheme` following the app theme. (c) Cancel/✕/Esc/mask-click abort the send: no message, no bubble (the optimistic echo is abandoned via `SubmissionHandle.abandon()`), the typed text stays in the composer, nothing stored; only the confirm button sends.

**Where it ran.** Mac mini battery: typecheck clean, **900/900** tests (39 data-layer with the real per-effort rows — GPT-6 Astra 50.6/54.2/57.9/57.9/58.2, Opus 5 with the `max`-field fallback; 108 dialog/gate). Browser, independently re-verified: the badge constant across every level for GLM 5.3 (`Terminal-Bench 4 · 41.8%`), MiMo and Kimi (`Intelligence · …`) INCLUDING the neutral option, and MOVING in the real picker on a temporary multi-effort model added to the isolated home (58.2/50.6/54.2/57.9/57.9/58.2, settings restored byte-identical); the select's computed paint in both themes (dark rgb(35,35,36) α=1, contrast 15.03:1; light #fff on rgb(15,17,21) 18.90:1; borders, `color-scheme`, option rows; focused and unfocused); and the four cancel paths on fresh composers (no bubble and no ghost, composer verbatim immediately and after 1.5 s, 0 user messages in the session log, 0 config POSTs, and a later send from the same composer landing as exactly one message). Battery: skill 202/203 (run 4, final scripts) and every legacy phase green — cancel 29/29, command 7/7, effort 25/25, light 7/7, small 10/10, confirm 14/14, workflow 11/11, readme 2/2, readme-light 1/1.

**Where the defects of this round were.** All in the two test scripts (never the product) and fixed there: the composer-clearing helper used `Control+A`, which is not select-all on macOS (drafts accumulated once cancel started preserving them); a translucent hover token parsed as "not painted" (NaN alpha) producing a false legibility failure; a missing `await` that crashed the light/small phases; and a crash report without a stack. The data layer also gained one deliberate, tested nuance: the "value at max" fallback is the snapshot's best-accuracy field, not the row labelled `max` (for Opus 5 the xhigh row is the best).

**Not covered.** The OS-drawn select popup is not painted into headless screenshots (legibility there rests on the computed option paint and `color-scheme`). S10 ("a subagent's own conversation") could not open its row in this reused home (its continuable parent sits behind "Show more sessions") — a test-state artifact; the behavior was verified in its own earlier runs.

## 0.8.2: the dialog's model area rebuilt (2026-10-08)

**What changed.** (a) The skill checkbox is un-gated again — always visible and toggleable (the 0.8.1 coupling left it inert in the default state). (b) The collapsible "Reasoning effort" section becomes a plain select, always visible right under the model picker, listing only the effective model's effort levels plus a neutral `Model default`; picking or changing a model selects its HIGHEST level at once (a stored level pre-fills at open). (c) A strip under the select marks the four input modalities (audio, photo, text, video) of the selected model and shows its headline score: Terminal-Bench 4.0 when the official leaderboard knows it (a build-time snapshot; `scripts/gen-bench.mjs` regenerates it), else OpenRouter's intelligence index. The data comes from OpenRouter's public `/models` (keyless, CORS) via the new `src/client/model-facts.ts`; nothing renders for an unresolvable model or an unreachable catalog.

**Where it ran.** The same Mac mini battery. Static: typecheck clean, **884/884** tests (29 new data-layer, 81 dialog/gate), the TB4 snapshot regeneration byte-identical (`gen-bench.mjs --check`). Browser, independently re-verified against the DOM, the POSTed configs and screenshots (not by the scripts' own assertions): the checkbox ticked+enabled with the switch off; zero Show/Hide controls and one `<select>` with ladder+neutral options positioned right under the model select; picking GLM 5.3 set "Max" and the POST carried `workerEffort:"max"`; the strip showed 4 named icons (marked/dimmed per fixture, hit-tested) and the badges `Terminal-Bench 4 · 41.8%` (TB4 beating the fixture's intelligence 44.8) and `Intelligence · 39.5` (the Azure-style DeepSeek id matched by slug on the live catalog); unknown model or broken catalog → no strip, no page error. Then the repaired battery: skill script **179/179 twice in a row** (a new facts group; the old X-group flakiness gone), legacy green without retries (cancel 11/11, command 7/7, light 5/5, small 6/6, effort 24/24 twice, confirm 14/14, workflow 11/11 — the child logs confirm the auto-max level and the 64 000-token cap reached the children), readme figures re-shot with the new dialog.

**Where the defects of this round were.** All in the test scripts, never in the plugin: the skill script's turn parser (an off-by-one that could not see the `turn/end`), its message-location helpers (DSH's "New session" switches sessions asynchronously and a phase could type into the composer left behind), and `ui-e2e.mjs`'s session-log reader (the wrong nesting depth — the product's auto-max was provably in the child logs all along). Fixed and re-run.

**Not covered / known.** The Terminal-Bench snapshot is dated 2026-10-08 and matches models by normalized name: the Claude family falls back to the intelligence index (its leaderboard labels do not match the OpenRouter slugs). The `file` modality has no mark (the strip shows the four the user asked for). A first failed catalog fetch yields no strip until the next page load. The S10 step of the skill script drifts in a shared home whose sessions grew titles from earlier runs (a run-ordering artifact; it passed 10/10 in its own runs).

## 0.8.1: the skill checkbox coupled to the subagent-model switch (2026-10-08)

**What changed.** The "Orchestration skill" checkbox is now gated by the "Subagent model" switch: with the switch
off the box is unchecked and disabled (with a hint pointing at the switch) and the send carries no token; turning
the switch back on restores the box's last state. The skill preference is written only when the box was actually
answered, so flipping the switch never overwrites it. One real defect fell out of the requirement: while the
model's reasoning ladder was unknown (the catalog loading or failed) a confirm silently dropped the stored
effort level to "recommended"; the stored level now stays selected and is written back.

**Where it ran.** The same Mac mini battery against freshly built bundles — `lib/client.cjs` sha256
`916549e5e352f8ff...`, byte-identical to the release build — 847/847 unit, integration and contract tests (+6 for
the coupling and the pre-fill), and in the browser: the skill script 132/132 (including the new coupling checks:
switch off renders the box unchecked and disabled, OFF→ON restores it, confirm with the switch off sends no token
and remembers nothing), a subagent's own conversation 10/10, the five earlier phases (cancel 11/11, command 7/7,
light 5/5, small 3/3 after the known flake, effort 16/16 — the effort phase is the live check that the dialog
reopens with the stored model and its stored level, not "recommended") and the README figures, re-shot with the
coupled states. 15/15 mutations of the changed logic die.

**Not fixed (harness quirks, not the plugin).** `ui-e2e-skill.mjs` numbers turns from the session's first turn, so
a "New session" that reuses an abandoned session can turn a correct send into a spurious FAIL (seen once; the log
showed the send was right); and `ui-e2e.mjs`'s `open()` still has its known landing race on the composer's
placeholder (it passes on retry). Both live in the test scripts only.

## 0.8.0: the orchestration skill, its dialog checkbox and the subagent list marks (2026-10-07)

**What was added.** Installing the plugin now registers one global agent skill (`orchestrate-subagents`) with DSH's
skill registry; the dialog gained an "Orchestration skill" checkbox (checked by default) whose only action is to put
the skill's `/name` token at the end of the message, so DSH's own skill gesture injects the instructions into that
step; and the task page's subagent dropdown now shows, per child, the model it runs on and its state (running, done,
failed, stopped) from a host-side ledger fed by DSH's `subagent/start` and `subagent/end` events.

**Where it ran.** Every run of this validation happened on the project's Mac mini test host (Apple M1, macOS 15) —
the operator moved heavy testing there before this release — against an isolated DSH home built from the user's
settings (main agent GLM 5.3 at `high`, `workspace-write` permissions) with only GLM 5.3 and DeepSeek V4.1 Flash
(Azure) used. The plugin under test was the working tree rsynced to `/Volumes/Ext2TB/dsh-orquestrator-validate`,
driven against the DSH 0.1.6-alpha.2 checkout (`ddefc45`) on the same machine. The maintainer's real DSH and
`~/.dsh` were never touched (the setup copies `settings.yaml` read-only once).

**Static battery.** `pnpm run typecheck` clean; `node scripts/gen-skill.mjs --check` up to date; the full suite twice
with `DSH_CHECKOUT` — **841 tests, 0 failed, 0 skipped** (122 suites; 6.9 s and 5.8 s) — and once in CI mode without
the checkout: **804, 0 failed**. `pnpm run build` twice produced byte-identical bundles in both rounds
(`lib/index.js` sha256 `aa27cc8330ec9b57...`, `lib/client.cjs` `d3f7699ea929099a...`) and the same hashes as the build
on the development machine: the committed artifacts are reproducible across machines. `scripts/check-lib.mjs` fails
at this point by design — it compares against git HEAD and the 0.8.0 `lib/` is not committed yet; it is the CI gate
for right after the commit.

**Browser battery** (a real `dsh web` in the isolated home; `scripts/e2e/ui-e2e-skill.mjs`, `ui-e2e-marks.mjs`,
`ui-e2e.mjs`, run through `scripts/e2e/with-server.sh`):

- **Skill checkbox and prompt injection: 127/127 checks** over 6 pages, 0 uncaught errors, 0 failed plugin
  responses. Covered: exactly one checkbox, checked by default and remembering the last answer; the token at the end
  of the message on a line of its own, and never in the first words of a first message of five words or more; the
  injected `<skill_content>` carrying the whole body of `SKILL.md`; a typed token never doubled; every cancel path
  (Escape, close button, Cancel, mask) sending the message untouched; `/orquestrar` with no skill section; the
  keyboard tour (14 Tab stops each way, Space toggles, Enter confirms); a 1024x600 screen with the effort block open
  (the stack scrolls, the primary action stays reachable); the light theme; and the wire behavior against an older
  host emulated with route interception (no `skill` field, `available: false`, a malformed offer, a failing route:
  no checkbox, no token; `skill: false` and `modelInvocable: false` verified against real host configurations). Two
  documented limits reproduce as advice lines: every tokened message re-injects a copy of the skill into the
  history, and a first message shorter than five words still carries the token in its automatic title.
- **A live run of two real subagents: 15/15** (the only model cost of this validation). Both children ran on
  `azure-opencode/DeepSeek-V4.1-Flash` at medium with the 64 000-token cap, and the ledger's two records match the
  children in the session logs (ids, parents, routes). The dropdown was captured mid-run (one spinner row) and after
  (two check rows).
- **A subagent's own conversation: 12/12.** The dialog there has no skill section and no checkbox, and both send
  paths post only the typed text to `/api/subagents/prompt` (the outgoing request was captured and aborted, so no
  model ran). The shipped S10 step of `ui-e2e-skill.mjs` skipped on the fresh home because it looked its parent up
  by one hard-coded session title (a replica script verified the behavior 12/12 at run time); the step's discovery
  was generalized afterwards and then ran its own checks 10/10 on the same home, keeping a clean skip for homes
  without children.
- **Subagent list marks: 146/146 checks** over 20 pages (3 skipped for fixtures a fresh home does not carry; the
  states they cover were driven through the ledger route instead). Confirmed: the status icon and its translated
  tooltip for every state (Running, Done, Failed: error, Failed: token limit reached, Failed: declined the task, an
  unknown reason raw, Stopped, Outcome not recorded); the model label follows DSH's own `lastUsed` first and the
  ledger's route second; a `running` record is believed for 5 s measured on the HOST clock (checked with a clock one
  hour off in both directions); a 404 is remembered for the life of the page (one request, no polling across reopens)
  while a 500 is retried; rows update in place with no duplicates; closing the menu removes every trace; the native
  rows keep working (labels, arrow to the sidebar, keyboard, `aria-label` unchanged) and each marked row gained an
  `aria-describedby`; and there were no page errors.
- **No regression in the earlier browser phases**: cancel 11/11, command 7/7, light 5/5, small 3/3 (after the known
  `open()` flake of `ui-e2e.mjs`, clean on retry), effort 16/16; plus `readme` 2/2 and `readme-light` 1/1 (the
  figures now in the README).

**A/B with real models: what the skill changes** (one sample per arm; main agent GLM 5.3 at high, subagents DeepSeek
V4.1 Flash; the same three-file task in both arms — create `greet.js`, `farewell.js` and `test.js`, `node test.js`
exits 0 — and only the checkbox differs):

| Measure | checkbox off | checkbox on |
| --- | --- | --- |
| Main agent tool calls | write ×6, bash ×2, present | todo_write ×5, subagent ×3, list_agents ×2, send_message ×2, get_goal, glob, job_list, present |
| Two `subagent` calls in one message | no (it batched 3 `write`s) | yes — the two writers, children created 1 ms apart |
| Main agent read/wrote/ran itself | 8 calls | 1 (a `glob`) |
| A separate verifier after the writers | no (it ran `node test.js` twice itself) | yes ("try to REFUTE the claim…"), started after the writers ended |
| The final answer says how it was verified | "prints `All tests passed`" | a proof section with the independent verifier's verdict |
| Children (model) | 0 | 3 (DeepSeek V4.1 Flash, medium, 64 000 cap) |
| Wall time / logged tokens | 9.5 s / 88 163 | 374.3 s / 1 082 308 |
| End state | 3 files, `node test.js` exit 0 | the same, exit 0 (probed) |

One sample cannot separate the token from the injection, and both runs share an artifact of the scratch workspace
(the repo's own `package.json` forced ESM rewrites in both arms). The honest summary: with the skill the model
orchestrates instead of doing the work itself, and on a small task that costs 39x the time and 12x the tokens for the
same end state — the skill pays when a task is big enough to parallelize and to need an independent check.

**The skill text was pressure-tested and fact-checked before it shipped.** Four imagined tasks (a code change, a
read-only question, a one-line fix, a 40-file migration) were played against it: the orchestration followed the rules
literally, and the frictions found became rules 3, 6 and 7 (the shared working tree, what a verifier runs, one
re-brief). A separate fact-checker then checked all 18 claims the text makes about DSH behavior against the DSH
source: 11 true, 1 false (in the shipped continuable mode a background subagent's result arrives in the completion
notice and no job exists for `job_output`), 4 partly, 2 unverifiable — plus 5 internal contradictions (a lookup that
cannot be stated unverified, an uncapped re-brief loop, per-piece verifiers running the full suite over a half-edited
tree). All six findings were fixed and the text regenerated.

**Three independent code reviews shaped what shipped** (host half, dialog/gate half, marks half; plus adversarial
experiments and mutation runs: 53 + 51 + 86 mutants, all killed after the fixes). Fixed before release: the
pre-existing dialog queue jam (since 0.6.0: a configure dialog for a conversation whose composer unmounted became the
current dialog, and every later send in every conversation hung until reload), sends reaching the host out of order,
a typed token ignoring the unticked box, a slow host silently dropping the checkbox, marks matching the wrong child
on identical labels or a prefix ("Review" capturing "Review the auth module"), a ledger call that never settled
wedging the marks forever, the staleness clock using the browser's clock against the host's records, hostile files in
the state directory (a symlinked temp file, a FIFO, a 93 MB ledger blocking load for 23 s), two processes on one
state directory dropping each other's records, the optional tracker aborting `apply()` before the start guard
installed, and an end event closing a newer run of the same child. Accepted and documented: the skill text is
re-injected by every tokened message (the checkbox is the control), a first message shorter than five words carries
the token in its title, a long model label ellipsizes at the effort name when the row's metrics column is wide, and
a continuable child's recorded route cannot be corrected at its end (DSH releases the agent first) — the page prefers
DSH's own `lastUsed`. The reviewers also found one DSH defect (a session rename never wins over the generated title
in the sidebar), which is upstream.

**Wire compatibility** was checked with the REAL 0.7.0 code in both directions: a 0.7 page reads and saves against the
0.8 host (the extra `skill` field is ignored), and a 0.8 page against a 0.7 host offers no checkbox and shows the
marks DSH itself supports (one 404 stops the ledger polling).

**Not covered.** The pt and zh renderings in a real browser (DSH's language is a setting), the `steer` delivery mode,
Firefox and Safari, screen readers, power-loss durability (the state writes are atomic but not fsynced), Windows and
Node 22, the marks script's own optional live phase (its states were covered by the live run above), and the 3 marks
checks that need fixtures a fresh home does not carry.

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
