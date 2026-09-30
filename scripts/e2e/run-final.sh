#!/usr/bin/env bash
# Runs after run-c-stock.sh:
#   B2  model-only + the main agent starts the subagent in the BACKGROUND (continuable path)
#   D2  scenario D again on the final build (does the reviewer catch/fix; is the report verdict-first?)
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"
here="$(cd "$(dirname "$0")" && pwd)"
for _ in $(seq 1 360); do
  grep -q "c done" "$root/c.out" 2>/dev/null && break
  sleep 10
done

write_overlay() { # $1 = reviewer enabled
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

task_b2='Call the subagent tool exactly once with run_in_background set to true, to create a file named answer.txt in the current directory containing exactly the text 42 (no newline). Do not wait for it inside the tool call. After starting it, run `sleep 60` in bash to give it time, then reply with one short sentence saying what answer.txt contains.'
task_d="$(sed -n "s/^task_d='\(.*\)'$/\1/p" "$here/run-d-e.sh")"

write_overlay false; "$here/run-headless-scenario.sh" B2-background "$task_b2" || true
write_overlay true;  "$here/run-headless-scenario.sh" D2-final "$task_d" || true
echo "final done; overlay restored"
