# Contributing to dsh-orquestrator

Thanks for your interest in contributing! This document explains the workflow, conventions, and
quality bar for every change to `frederico-kluser/dsh-orquestrator`.

Please note that this project is released with a [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.

## Getting started

1. **Fork** the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/<your-user>/dsh-orquestrator.git
   cd dsh-orquestrator
   git remote add upstream https://github.com/frederico-kluser/dsh-orquestrator.git
   ```

2. **Bootstrap a reproducible environment** — always install from the lockfile so everyone gets the
   same dependency tree:

   ```bash
   pnpm install         # also installs the git hooks (husky) via the prepare script
   ```

   Use the toolchain the project pins: **Node.js >= 24** (see `engines` in `package.json`) and
   **pnpm** against the committed `pnpm-lock.yaml` — never commit lockfile churn produced by
   another package manager.

3. **Verify the baseline** before changing anything:

   ```bash
   pnpm run check       # typecheck + build + tests + the committed lib/ matches a fresh build
   ```

## How to submit a change

- **Never push directly to `main`.** Direct pushes are blocked by repository rulesets;
  all changes land through pull requests.
- Work either on a **fork** (external contributors) or on a short-lived **ephemeral branch** in the
  main repository (maintainers), then open a pull request against `main`.
- Keep each branch focused on a single change: small, reviewable pull requests get merged faster.
- Keep your branch up to date by rebasing on `upstream/main` (do not merge
  `main` into your branch).

## Branch naming

Use a short, descriptive prefix:

| Pattern    | Use for                             | Example                    |
| ---------- | ----------------------------------- | -------------------------- |
| `feat/*`   | New functionality                   | `feat/rate-limiter`        |
| `fix/*`    | Bug fixes                           | `fix/null-pointer-parser`  |
| `chore/*`  | Maintenance, tooling, dependencies  | `chore/upgrade-ci`         |

Other conventional prefixes (`docs/*`, `refactor/*`, `test/*`, `perf/*`, `ci/*`) are welcome where
they fit, but `feat/*`, `fix/*` and `chore/*` cover the vast majority of work.

## Commit convention

We use [Conventional Commits](https://www.conventionalcommits.org/). The commit message becomes the
changelog entry and drives the semantic version bump, so the format is enforced.

Accepted:

```text
feat: add exponential backoff to the HTTP client
fix(parser): handle empty input without throwing
docs: document the plugin lifecycle
feat!: drop support for Node 16

feat: add retry support to the HTTP client

BREAKING CHANGE: the client constructor now requires an options object.
```

Rejected:

```text
Fixed bug                          # missing type
FEAT: add stuff                    # type must be lowercase and one of the allowed types
FEAT: ADD STUFF                    # subject must not be SHOUTING (upper-case)
fix(parser): Handle Empty Input    # subject must not be Start Case/PascalCase
feat: add a very long subject that goes way beyond the seventy-two character limit   # header > 72 chars
feat:no space after colon          # missing space after the type separator
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. The header must be at most **72 characters**. The subject may start upper- or lower-case
and keeps mid-sentence capitals for proper nouns and acronyms (the repository's own history does);
what is banned is ALL-CAPS, Start Case and PascalCase.

> The `commit-msg` git hook (husky + commitlint) **rejects invalid messages at commit time**. If
> your commit was refused, fix the message with `git commit --amend` (or `git rebase -i` for older
> commits) instead of bypassing the hook.

## Local quality gates

Run these before opening a pull request — all of them must pass:

```bash
pnpm run check        # typecheck + build + unit/integration tests + lib/ drift check
pnpm run check:lib    # the committed lib/ must equal a fresh build (run after committing lib/)

DSH_CHECKOUT=/path/to/deepseek-harness pnpm test
# also pins the DSH seams this plugin uses (test/contract/); it needs a DSH
# checkout, so CI runs the suite without it
```

Add or update tests for every behavioural change; a bug fix should include a regression test that
fails without the fix.

## Pull request process

1. **Title = Conventional Commit message.** The title is used as the squash-merge commit message, so
   it must follow the same convention (e.g. `feat: add exponential backoff to the HTTP client`).
2. **Describe what and why** in the body: motivation, approach, alternatives considered. Use the
   [pull request template](.github/PULL_REQUEST_TEMPLATE.md) checklist.
3. **Link related issues** with closing keywords (`Closes #123`) so issues close automatically on
   merge.
4. **Keep it green locally**: `pnpm run check` must pass before requesting review. The same checks
   run in CI as the required status check (`verify`).
5. **Review requirements** (enforced by repository rulesets and [CODEOWNERS](CODEOWNERS)):
   - A pull request is **required** — direct pushes to `main` are blocked by rulesets.
   - Required approvals: **none while the project has a single maintainer** (nobody can approve
     their own pull request). When a second maintainer joins, approvals and code owner review get
     turned on in `.github/rulesets/regras-main.json`.
   - The branch must be up to date with `main` and every required status check green.
   - Stale approvals are dismissed automatically when new commits are pushed.
6. **Squash and merge only.** Maintainers merge with the squash strategy and delete the source
   branch afterwards; the pull request title becomes the permanent commit message. Do not merge with
   merge commits or rebase-merge.

## Reporting bugs

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include a minimal
  reproduction, expected vs. actual behaviour, versions, and environment details.
- Feature ideas go through the
  [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
- **Security vulnerabilities must not be reported as public issues.** Follow the private process in
  [SECURITY.md](SECURITY.md) instead.

## Recognition

Every contribution counts and every contributor is credited:

- The changelog and release notes attribute merged changes to their authors.
- First-time contributors are thanked in the release announcement that includes their change.
- Significant, sustained contributions are recognised with maintainer/commit bit invitations.

Thank you for helping make dsh-orquestrator better!
