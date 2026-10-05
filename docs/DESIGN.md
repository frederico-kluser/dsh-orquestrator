# Design notes

Why the plugin is shaped the way it is. Everything here was checked against the
DSH source (`test/contract/dsh-source.test.ts` pins the seams) and against a real
DSH 0.1.6-alpha.2 (see [validation/README.md](validation/README.md)). The reasoning-effort
ceilings come from sixteen studies; their digest, the decision log and the reasons for every
recommendation that was **not** adopted are in [estudos/](estudos/README.md).

Versions 0.2 to 0.4 also had an independent reviewer next to the model choice. It was removed in
0.5.0 (decision D16 in [estudos/decisoes.md](estudos/decisoes.md)); its protocol and the
research behind it stay in the repository as history
([pesquisa/padrao-revisor.md](pesquisa/padrao-revisor.md), Portuguese).

## The problem

DSH lets the main agent delegate in several ways: the `subagent` and `subagent_fork`
tools, and the `workflow` tool, whose script starts dozens of agents (plus one-shot
background jobs, `ralph` and agent teams). The user cannot say, per task, "run the
subagents on another model", and a child that DSH re-routes runs at its route's default
effort (`max` on the deployments this targets) with the route's full output ceiling. This
plugin asks once, when a new task is sent, and then enforces the answer in code on every one of
those paths.

Cancel, Escape and the close button all mean the same thing: **send the task
exactly as stock DSH would**. Nothing else changes.

## Architecture

```
 browser                                         host (DSH process)
 ┌─────────────────────────────────────┐        ┌──────────────────────────────────────────┐
 │ composer ─ send ─▶ SessionFace.prompt│        │                                          │
 │        (class prototype, wrapped)    │        │  /dsh-orquestrator/config  (GET / POST)  │
 │   PromptGate ─ new task? ─▶ modal    │◀──────▶│   trust fence ─▶ validate ─▶ ConfigStore │
 │   confirm ─ POST config ─────────────┼───────▶│                            (sessions.json)│
 │   cancel  ─ POST null   ─────────────┼───────▶│                                          │
 │   then the ORIGINAL prompt is sent   │        │  SubagentRuntime.start / startContinuable│
 └─────────────────────────────────────┘        │   (the start guard: own wrappers on the  │
                                                 │    service instance)                     │
                                                 │   any child: subagent tools, workflow,   │
                                                 │   ralph, job, team                       │
                                                 │   ├ no stored choice ─▶ stock            │
                                                 │   └ plan it ─▶ agentOptions              │
                                                 │      (route, effort ceiling, token cap)  │
                                                 └──────────────────────────────────────────┘
```

Two halves, one package (`lib/index.js` for the host, `lib/client.cjs` for the
browser). The web-only pieces (the route and its trust fence) attach through a
nested `ctx.inject`, so the guard also works in headless, TUI and SDK profiles, driven by the
`defaults` config.

### Host

| File | Role |
| --- | --- |
| `src/guard.ts` | The start guard, the plugin's only mechanism. Installs own `start` and `startContinuable` on the `SubagentRuntime` instance (reached through the service proxy's `Symbol.for('cordis.original')`) and, for a session with a confirmed choice, plans every child: the picked route, the effort the user asked for or the model's ceiling, the output-token cap. Never breaks a start because of its own trouble; rejects a start whose confirmed model no longer exists; fails the plugin load if the service cannot be wrapped. |
| `src/effort.ts` | `planChild()`: the route, reasoning effort and output-token ceiling of one child, planned against what DSH really merges. |
| `src/models.ts` | Shared with the browser. Dated per-model reasoning-effort ceilings and dialog notes, and `chooseEffort()`. |
| `src/config.ts` | Validated deployment configuration (`defaults`, `effort`, `limits`, `children`, state options); the fields of the removed reviewer are ignored with a warning. |
| `src/store.ts` | Per-session choice, persisted atomically as owner-only JSON, LRU-pruned, resolved through the session lineage. |
| `src/routes.ts` | The config route: trust fence first, bounded body, strict validation, the named route validated through the live LLM runtime. |
| `src/shared.ts` | The wire contract shared with the browser: the per-session choice (a model and an effort), its tolerant parser (a record written by 0.4 that still carries a reviewer block loads, and the block is dropped) and the route paths. |

### Browser

| File | Role |
| --- | --- |
| `src/client/gate.ts` | Wraps `prompt` on the session **class prototype** (refcounted, restored exactly; instance fallback for plain objects). Fail-open: any error sends the task as stock. |
| `src/client/dialogs.ts` | One dialog at a time, a queue, presenter registry, abort handling. |
| `src/client/OrchestratorOverlay.tsx` | A `conversation.input.overlay` slot occupant with no visual of its own: registers as presenter, attaches the gate, renders the dialog. |
| `src/client/OrchestratorDialog.tsx`, `ModelPicker.tsx`, `EffortPicker.tsx` | The dialog, built only from DSH primitives (`Modal`, `Switch`, `Button`, `Menu`) and DSH tokens: one switch with a model picker and model notes, and a collapsed reasoning-effort block. |
| `src/client/focus-trap.ts` | Keeps Tab inside the dialog (the host `Modal` declares `aria-modal` but does not contain focus). |

## Decisions and the evidence behind them

| Decision | Why |
| --- | --- |
| Every child is governed in the two doors of `SubagentRuntime`, not by wrapping tools | The `workflow` tool, `ralph`, jobs and agent teams do not call a delegation tool: they call `ctx.subagents.start()` / `startContinuable()`. Those two methods are the only way a provider is started and a child agent is created (pinned in `test/contract/dsh-source.test.ts`), so one guard there covers every present and future caller. Wrapping tools would have to name each one and would miss the next ([estudos D15](estudos/decisoes.md)). The `subagent` and `subagent_fork` tools run entirely stock: the guard alone puts their child on the pick (run live with no tool wrapper at all). |
| The guard wraps the service instance, and the plugin fails to load if it cannot | DSH has no hook around a child start (`subagent/start` is a notification after the child exists), so there is no supported seam. The instance behind a Cordis proxy is what every proxy reads, and it is reachable under a registered global symbol. A guard that silently did nothing is exactly how the workflow hole stayed open, so a service that cannot be wrapped is a load error; the contract tests (static pins and a run on the real built `SubagentRuntime`) fail first when DSH changes the assumption. |
| What the guard hands to DSH is marked | An own enumerable symbol property on the guard's copy of the request (an object spread copies it, so a wrapper stacked above the guard cannot strip the mark by copying the request) says "already planned", so a second live guard (another copy of the plugin) plans each child once and the newer configuration wins. The caller's own request object is never marked. |
| A confirmed model that no longer exists rejects the start | Fail open would put the child on the main agent's model (the bug this guard exists for); forcing the dead route makes every workflow agent fail its first request into a silent `null` and leaves one log line. The start is rejected with a message that names the model and says what to do, so a workflow fails loudly (`AGENT_START`) and the `subagent` tool returns the same message. Only the user's own pick is defended this way; a model the caller named (`keep`) is left to DSH. |
| The planner plans against what DSH really merges | DSH clears the parent's effort only when the child's route changes (a child on the parent's own route inherits it) and hands the parent's creation token limit down on every route. The ceiling therefore looks at the inherited level and limit, never above what the model allows, and the effort of a merged request comes from the plan alone (a level the planner dropped must not be spread back in from the caller's options). |
| The user's pick wins over a model the caller names (`children.explicitModel: override`) | The dialog is the user's explicit instruction; a script written by the main agent is not. `keep` lets a named model stand under the ceilings, for setups where a script legitimately pins a model (for example a vision model). With no subagent model picked (an effort-only choice), a named model always stands: the user did not state a preference. |
| Replacing a child's options when the user's route wins, but never raising a limit the caller set | `AgentOptions` is provider, model, effort and token limit (pinned), and an effort chosen for another model must not travel to this one (an unsupported effort fails the first request). A token limit is route-agnostic in intent (an operator's tool row, a team roster), so the smaller of the caller's and the plan's stands. |
| Every child gets a reasoning-effort **ceiling** and an output-token cap | DSH deletes the parent's effort when a child's route changes, so the child runs at the route's default, which is `max` on the deployments this targets, with the route's full declared output ceiling (131K to 943K tokens here). That produced a subagent that spent its token budget on one edge case and a slow model that needed minutes per turn. The ceiling is a ceiling, not a setting (a route already below it is untouched), comes from the model's own ladder, and yields to an explicit user pick ([estudos D01, D02](estudos/decisoes.md)). |
| The output-token cap is not durable for `continuable` children | A finished child is released and a later message cold-resumes it from its recorded descriptor, which holds provider, model and effort but not the token limit. Documented, not fixed: a fix needs a per-request seam ([estudos N21](estudos/decisoes.md)). |
| The plugin does not check what a subagent produces | An independent reviewer did in 0.2 to 0.4. It was an LLM judging an LLM, doubled the cost and covered two of the paths; what the plugin enforces in code is deterministic, and the verification of the work is left to the main agent and the project's own tests ([estudos D16](estudos/decisoes.md)). |
| The modal opens for **every** message the user sends (0.6.0) | The operator's rule is that the dialog always appears — plain text, `@file` references or `/skill` invocations, in any conversation, queue or steer. Earlier releases skipped `/` lines, messages sent while a turn ran and sub-agent conversations, so every task that began with a skill invocation never saw the dialog ("the modal does not appear for some models or conversations"). "Slash commands are not new tasks" was wrong about the mechanism: a real command never reaches `prompt`, and a slash line that does is a task. Only an empty send passes straight through. |
| The modal asks even when the host route cannot answer (0.6.0) | A missing or unreadable `/dsh-orquestrator/config` used to skip the question silently — exactly what a host/page version mix produced. The dialog now asks, pre-filled from the last choice, and a confirm says out loud that the choice could not be stored; a question whose save fails is better than a modal that never appears. Only "nobody can render the dialog" (no composer mounted) stays fail-open. |
| There is no "do not ask again": the modal asks on every new task | Any remembered silence spreads. DSH's web client reuses a workspace's empty session for every "New session" (`ui-workspace` `connectWorkspace`), so a choice remembered in one conversation silenced the modal for every conversation the user opened in that workspace. The stored choice only pre-fills the dialog (a legacy `remember` field is accepted and ignored). |
| Prompt wrapping on the prototype, not the instance | A reconnect can re-create the session face; a prototype patch survives it. |
| Dialog advice is dated data that annotates and never blocks | The catalog belongs to the user. The dialog shows per-model cautions, each row dated and sourced in `src/models.ts` ([D11](estudos/decisoes.md)). |
| The plugin ships inert | No stored choice and no `defaults` means stock behavior. |
| Both ends keep a disabled `reviewer` block on the wire (0.5.1) | The host half loads when `dsh` starts, the browser half when the page loads, so after an update the two can differ for as long as it takes to restart (a refreshed page against the old host, a tab opened before a restart against the new host). 0.2 to 0.4 refused a configuration without the block, and the browser refused an answer without it: every save failed ("config does not match the expected shape"). The browser posts it and the host answers with it, as a frozen constant; 0.5 ignores it and never stores it. A fixture with the old strict parser pins that what goes on the wire still passes it. Drop it once nobody runs 0.4. |
| Records and patch files written for 0.4 keep working | The parser reads a stored choice that still carries a reviewer block and drops it (a reviewer-only choice becomes the inert configuration); the removed configuration fields are ignored with one warning each. |

## Security

- The config route sits behind the DSH browser trust fence and refuses anything
  it rejects before reading a byte of the body.
- Bodies are bounded (64 KiB), content-type checked, parsed strictly; unknown
  fields are dropped; the named model route is resolved through the live LLM runtime
  before it is stored.
- Persisted state contains routes and effort levels only, written atomically with mode
  `0600`. No credentials pass through the plugin. The file holds one process's
  view (last writer wins); two DSH processes that both *set* choices in the same
  state directory can drop each other's entries, so give each its own `stateDir`.
  Headless `defaults` are never written to the file.
- The plugin runs no code of the subagents and starts no process: it only changes the options
  DSH starts a child with. It provides no sandbox, no network filter and no control of the process
  environment; what subagents may do is decided by the session's permission preset, as without the plugin.
- What the plugin deliberately does not do, with the reason for each, is in
  [estudos/decisoes.md](estudos/decisoes.md) (N01 to N22).
