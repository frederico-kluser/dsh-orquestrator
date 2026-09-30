#!/usr/bin/env bash
# Scenarios D and E against the isolated headless profile.
#   D  worker + reviewer on a spec with several easy-to-miss rules (does the reviewer catch and fix?)
#   E  the reviewer's model cannot be resolved (does the worker's report arrive under the UNREVIEWED banner?)
# Waits for run-b-c.sh to finish first: both edit the profile overlay.
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"
here="$(cd "$(dirname "$0")" && pwd)"

for _ in $(seq 1 180); do
  grep -q "overlay restored" "$root/b-c.out" 2>/dev/null && break
  sleep 10
done

write_overlay() { # $1 = reviewer model id
  cat > "$overlay" <<YAML
- id: orquestrator
  config:
    stateDir: $root/state
    defaults:
      subagentModel: { provider: openrouter, model: google/gemini-3.8-flash }
      reviewer:
        enabled: true
        model: { provider: $2, model: $1 }
YAML
}

task_d='Use the subagent tool exactly once to do this work: in the current directory create duration.js (CommonJS) exporting parseDuration(text) that converts a duration string to whole seconds. Rules: units are d, h, m and s (86400, 3600, 60 and 1 seconds); tokens look like 1d, 2h, 30m, 45s and may be separated by single spaces; units must appear in descending order d, h, m, s and each unit may appear at most once; whitespace inside a token (for example 1 h) is invalid; any invalid input, including an empty string and a non-string, must throw a TypeError whose message is exactly invalid duration; a total above 99 days must throw a RangeError whose message is exactly too long. Also create duration.test.js with node:test cases covering every rule, and run them with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.'
task_e='Use the subagent tool exactly once to do this work: in the current directory create hello.txt containing exactly the text hello (no newline). When the subagent tool returns, reply with its result verbatim and nothing else.'

write_overlay claude-haiku-4-5 azure-opencode-claude
"$here/run-headless-scenario.sh" D-reviewer-fixes "$task_d" || true
write_overlay does-not-exist/none openrouter
"$here/run-headless-scenario.sh" E-unreviewed "$task_e" || true
write_overlay claude-haiku-4-5 azure-opencode-claude
echo "d-e done; overlay restored"
