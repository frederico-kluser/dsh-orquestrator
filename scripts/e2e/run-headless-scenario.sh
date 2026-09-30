#!/usr/bin/env bash
# Run ONE headless DSH scenario against an isolated DSH_HOME and keep the evidence.
#
#   run-headless-scenario.sh <name> <task text>
#
# Environment:
#   ORQ_VALIDATION_ROOT  root of the isolated validation area (default /Volumes/Ext2TB/dsh-orq-validation)
#   ORQ_PROFILE          DSH profile to boot (default headless)
#
# Evidence written under $ORQ_VALIDATION_ROOT/runs/<name>/:
#   events.jsonl   `dsh --json` run events
#   stderr.log     diagnostics (plugin logs land here)
#   workspace/     the git workspace the agents worked in (state after the run)
set -euo pipefail

name="${1:?scenario name}"
task="${2:?task text}"
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
profile="${ORQ_PROFILE:-headless}"
run="$root/runs/$name"

export DSH_HOME="$root/home"
rm -rf "$run"
mkdir -p "$run/workspace"
cd "$run/workspace"
git init -q -b main
git config user.email "validation@example.invalid"
git config user.name "orq validation"
printf '# scratch workspace for %s\n' "$name" > README.md
git add README.md && git commit -q -m "chore: empty workspace"

started=$(date +%s)
set +e
dsh --profile "$profile" --json "$task" > "$run/events.jsonl" 2> "$run/stderr.log"
status=$?
set -e
echo "exit=$status seconds=$(( $(date +%s) - started ))" | tee "$run/result.txt"
