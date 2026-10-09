# Rulesets — governance as code

The JSON files here are exactly what is applied to the repository
(`POST /repos/{owner}/{repo}/rulesets`). Re-apply after cloning or when a file
changes:

```bash
gh api --method POST repos/frederico-kluser/dsh-orquestrator/rulesets \
  --input .github/rulesets/regras-main.json
gh api --method POST repos/frederico-kluser/dsh-orquestrator/rulesets \
  --input .github/rulesets/regras-tags.json
```

## `regras-main.json` — `main` (and any `release/**` branch) is a vault

| Rule | Effect |
| --- | --- |
| `deletion` | `main` can never be deleted |
| `non_fast_forward` | no force-push, no history rewriting |
| `required_linear_history` | no merge commits land on `main` |
| `pull_request` | every change lands through a PR, **squash only** |
| `required_status_checks` | the `verify` check must be green, on an up-to-date branch |

**Deliberate deviation from the multi-maintainer template:** `required_approving_review_count`
is `0` and `require_code_owner_review` is `false`. The project has a single maintainer and GitHub
never lets you approve your own pull request — required approvals would deadlock every merge.
When a second maintainer joins, raise the count to `1` (or `2`), set
`require_code_owner_review: true`, and split ownership in [`CODEOWNERS`](../../CODEOWNERS).

`bypass_actors` is empty on purpose: only GitHub Apps (bots) may ever bypass a ruleset; humans go
through the PR.

## `regras-tags.json` — release tags are immutable

`v*` tags can never be updated or deleted: a published version must always resolve to the same
code. Re-releasing a broken version means publishing a new version, never moving the old tag.
