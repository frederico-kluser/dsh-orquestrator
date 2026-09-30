# Validation

Everything in this plugin was validated on a Mac mini over SSH against a real
DeepSeek Harness, not only against mocks. This page states what was run, what it
proved, what it found, and what it did not cover.

## Environment

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

## What was checked

### 1. Build and tests on the target machine

`git clone` from GitHub, `pnpm install --frozen-lockfile`, `pnpm run build`, then the
whole suite with `DSH_CHECKOUT` pointing at that machine's DSH source.

- The committed `lib/` is byte-identical to a fresh build on a second machine
  (`git status` clean after building).
- Unit and integration tests pass, and the contract tests pin the DSH internals the
  plugin depends on: the `tools/execute` waterfall and its result re-validation, the
  subagent tool's output schema, `SubagentRuntime` (`start`, `startContinuable`,
  `resolveMaxDepth`, `getProvider`), `SessionFace.prompt`, the composer overlay slot,
  the primitives and their props, and the shell's module table.

### 2. Real delegation, headless ([`runs/`](runs))

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

### 3. The dialog, in a real browser against the real web server

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

### 4. UX self-audit

Applied the uxuiprinciples framework (no API key, so from internal knowledge and
without citations; a self-assessment, not an independent audit):
[before](uxui-audit-before.json) scored 80 (good), [after](uxui-audit-after.json) scored 94
(excellent) once the two warnings were fixed.

## What validation found, and what changed

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

## Not covered

- Profiles other than `web` and `headless` (TUI, SDK).
- One-shot `subagent` background jobs are not orchestrated by design.
- Only macOS/arm64 was exercised end to end; the code has no platform-specific paths.
- A reviewer that repairs is measured on the runs above, not on a benchmark. The
  research dossier says why no published study settles that question.
