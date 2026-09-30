#!/usr/bin/env bash
# Scenario F2: the planted-defect task of F, on the build whose reviewer persona
# has the "a conflict between requirements is not a pass" rule.
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
here="$(cd "$(dirname "$0")" && pwd)"
task="$(sed -n "s/^task='\(.*\)'$/\1/p" "$here/run-f.sh")"
"$here/run-headless-scenario.sh" F2-conflict-rule "$task" || true
echo "f2 done"
