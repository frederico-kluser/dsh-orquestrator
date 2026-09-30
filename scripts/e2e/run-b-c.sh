#!/usr/bin/env bash
# Scenarios B (model only) and C (stock) against the isolated headless profile.
# Leaves the profile overlay as scenario A expects it (worker + reviewer).
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"
here="$(cd "$(dirname "$0")" && pwd)"
task='Use the subagent tool exactly once to do this work: in the current directory create a file named answer.txt containing exactly the text 42 (no newline). When the subagent tool has finished and you have its result, reply with one short sentence saying what the file contains.'

write_overlay() { # $1 = reviewer enabled (true|false) or "none"
  if [ "$1" = none ]; then : > "$overlay"; return; fi
  cat > "$overlay" <<YAML
- id: orquestrator
  config:
    stateDir: $root/state
    defaults:
      subagentModel: { provider: openrouter, model: google/gemini-3.8-flash }
      reviewer:
        enabled: $1
        model: { provider: azure-opencode-claude, model: claude-haiku-4-5 }
YAML
}

write_overlay false;  "$here/run-headless-scenario.sh" B-model-only "$task" || true
write_overlay none;   "$here/run-headless-scenario.sh" C-stock "$task" || true
write_overlay true
echo "overlay restored to worker + reviewer"
