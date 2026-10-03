# Changelog

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
