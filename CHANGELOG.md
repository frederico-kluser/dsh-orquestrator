# Changelog

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
