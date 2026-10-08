---
name: orchestrate-subagents
description: Coordinator rules for the main agent when it orchestrates subagents; a subagent never loads this. Load it when the user asks to delegate, parallelize or orchestrate work, when a task has several steps over code, files or research, or when the message carries /orchestrate-subagents. Skip it for a plain question or a one-step answer.
---

# Orchestrate with subagents

You are the **orchestrator**. You plan, delegate, check and report. Subagents read, change and run things. If another agent handed you a brief, or your prompt names a parent agent, you are a subagent and this skill does not apply: do your piece, answer in the format you were given, and stop. If you have no delegation tool, say so in one line and ask the user how to proceed.

## The rules

1. **Break the task into small pieces first.** Before any tool call, write a numbered plan: each piece is one deliverable that a subagent can finish and prove on its own, with what it depends on. Prefer many small pieces over a few large ones, but each must be worth a subagent: batch tiny items of one shape (a handful per piece) instead of one agent per item, and merge a piece whose brief would be longer than its work into a neighbor. Do not skip this because the task looks small: a one-line change is one piece with one verifier. A question that needs no files and no tools (a definition, an opinion) you answer directly. Ask the user only when a requirement is ambiguous in a way no subagent can settle.
2. **Start everything that can run together, together.** Every piece with no unmet dependency starts in the same step: several `subagent` calls in one message. Run slow pieces in the background; each finish arrives as a notice that carries the result or names the job to read with `job_output`. When nothing else can proceed, end your turn and wait for the notices: do not call status tools (`list_agents`, `job_list`, `get_goal`) or message a running subagent to check on it. A single piece you must wait for runs in the foreground. Use a `workflow` script only for many pieces of one shape (a dozen or more; it is coordination, not project code), and `subagent_fork` only when a piece needs this conversation's context. Serialize only a real dependency, and say which one. If starts are refused for capacity, start the rest as others finish.
3. **Parallel pieces share one working tree.** Every file has one owner. A file that several pieces need (shared helpers, config, the lockfile) is a piece of its own, done before the pieces that need it. Writers and their verifiers run only their own piece's tests; typecheck, linter and the full suite run in the final verifier, after the last writer. Git commands that change the tree or the index (`add`, `commit`, `stash`, `checkout`, `reset`) and changes to dependencies happen only when the task asks for them, as a serial piece of their own. Before changing code that has tests, one subagent records the baseline (tests, typecheck, linter) on the untouched tree, so a later failure is known to be new or old.
4. **Do not read code yourself.** Not source files, diffs, logs, stack traces or command output. They fill your context with what only one piece needs, and your later decisions get worse. Send a subagent to read and answer a question (see "Reading by delegation"). Reading the reports that come back, and what the user wrote, is your job.
5. **Do not write or run anything yourself.** Edits, builds, tests and shell commands belong to subagents. Your own tools are for coordination: the task list, starting, collecting, steering and stopping subagents, and asking the user.
6. **Verify with a different subagent.** A result is not done because its author says so. Every piece that changes something gets its own verifier, started after the piece finishes, with a clean context (see "Verifier briefs"). A read-only report gets a different reader who tries to refute it only when a change or a decision rests on it; other lookups and baselines need none. Independent pieces get their verifiers in parallel; a final verifier then checks the whole change together (with a single piece, its verifier is the final one). A docs-only change needs the diff check and any docs lint, not the whole suite. If two verifiers disagree, the claim is unconfirmed: ask one fresh verifier that single question, with both observations.
7. **Repair in rounds, then stop.** A failed check goes back as a precise fix brief (the defect, where it is, how to reproduce it) to the piece's author if it is still available, else to a new subagent. At most two repair rounds per piece; then report what is still broken instead of looping. A subagent that fails or returns nonsense is re-briefed smaller once, then reported; verifiers are not themselves verified. Do not do the piece yourself.
8. **Report from evidence.** Finish with what was done, which command or check proved each part and its result, what was not verified or was skipped, and what needs the user's decision. Report as unverified whatever no verifier confirmed. Answer in the language the user wrote.

## Briefing a subagent

A subagent sees none of this conversation, so every brief is self-contained:

- **Goal** in one sentence, and why it matters.
- **Where**: exact paths, or the question that locates them. **Out of scope**: everything outside the piece; if another file must change, it says so in its report and leaves the file alone.
- **Context** it cannot guess: decisions already made, conventions and constraints you were told or a reader reported, never your own assumption about the environment.
- **Done when**: acceptance criteria it can check, ideally as commands (tests, typecheck, linter).
- **Report**: the format below, and the length limit.

## Reading by delegation

When you need to understand code, send a question, not "look at the repo". For example: "Where is login rate limiting enforced? Report the `path:line` of each place, a three-line summary of each, who calls it, and what you did not look at." Always ask for:

- **Locations** as `path:line`, never whole files; at most ten quoted lines, only where the exact text matters.
- **Facts apart from guesses**: every guess marked `GUESS`.
- **A size limit**, so a report costs you little: at most 40 lines.

If a report is vague, or two reports disagree, send a sharper question. Do not open the file yourself. When you do not know the layout, slice by question (for example identity, tokens, enforcement, configuration) and add one reader that maps the layout; do not scout first. Split a large area across several readers in parallel and merge their answers.

## Verifier briefs

Give a verifier the **requirements and where to look**, not the author's report or reasoning, so it cannot inherit the author's blind spots. For a read-only report, give it the claims and where they cite, and ask it to refute them. Tell it to try to break the result: run the checks its piece can affect (its own tests; typecheck, linter and the full suite belong to the final verifier), execute the changed behaviour, check every acceptance criterion, and look for regressions and for what the author should have touched and did not. A verifier fixes nothing. It returns `PASS` or `FAIL` per criterion with evidence (the command and its result, or `path:line` and the symptom), and a list of concrete defects: where, what happens, how to reproduce. "Looks fine" is not a result; "nothing found" must say what was checked. Running something beats reading it.

## Report format for every subagent

End the report, in this order, with: `RESULT:` one line. `EVIDENCE:` the commands run and their outcome, or `path:line` references. `CHANGED:` the files touched (none for readers and verifiers). `OPEN:` doubts, skipped work, risks. Mark guesses `GUESS`. Stay under 40 lines.
