#!/usr/bin/env bash
# Scenario C alone: the plugin is installed but has no choice and no defaults,
# so delegation must behave exactly like stock DSH. Waits for run-d-e.sh
# (both edit the profile overlay), and restores the worker + reviewer overlay.
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"
here="$(cd "$(dirname "$0")" && pwd)"
for _ in $(seq 1 240); do
  grep -q "d-e done" "$root/d-e.out" 2>/dev/null && break
  sleep 10
done
task='Use the subagent tool exactly once to do this work: in the current directory create a file named answer.txt containing exactly the text 42 (no newline). When the subagent tool has finished and you have its result, reply with one short sentence saying what the file contains.'
printf '[]\n' > "$overlay"          # a top-level YAML array, empty: no plugin config at all
"$here/run-headless-scenario.sh" C-stock "$task" || true
cat > "$overlay" <<YAML
- id: orquestrator
  config:
    stateDir: $root/state
    defaults:
      subagentModel: { provider: openrouter, model: google/gemini-3.8-flash }
      reviewer:
        enabled: true
        model: { provider: azure-opencode-claude, model: claude-haiku-4-5 }
YAML
echo "c done; overlay restored"
