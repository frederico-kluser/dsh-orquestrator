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

### 2. Real delegation, headless (`runs/`)

| Run | What it proves |
| --- | --- |
| **A** worker + reviewer | The main agent's `subagent` call is intercepted at the root context; a worker child runs on the chosen model, a reviewer child on another; the tool result the main agent receives is the **reviewer's** report under a `Reviewed delivery ... [verdict: ...]` banner; the worker's own report does not reach the main agent. |
| **B** model only | Only the child's model changes; the main agent gets the worker's own result, as stock. |
| **B2** model only, background | The `continuable` path: the main agent starts the subagent in the background and is notified when it finishes. |
| **C** stock | The plugin loaded with no choice and no defaults leaves delegation exactly as stock DSH. |
| **D / D2** reviewer on a spec with easy-to-miss rules | Whether the reviewer catches and fixes what the worker missed, and whether the report is verdict-first. |
| **E** reviewer cannot start | The worker's report is delivered under `WARNING - UNREVIEWED` instead of being lost. |

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
7. **Runner bugs, not plugin bugs.** An empty profile overlay is not a valid patch (it
   must be `[]`); `git pull` aborted over files copied by hand; a burst of 36 parallel
   research verifiers exhausted the search API's key pool (see the dossier, section 8).

## Not covered

- Profiles other than `web` and `headless` (TUI, SDK).
- One-shot `subagent` background jobs are not orchestrated by design.
- Only macOS/arm64 was exercised end to end; the code has no platform-specific paths.
- A reviewer that repairs is measured on the runs above, not on a benchmark. The
  research dossier says why no published study settles that question.
