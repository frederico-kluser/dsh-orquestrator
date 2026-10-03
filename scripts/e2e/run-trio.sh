#!/usr/bin/env bash
# Headless validation of the plugin on the three target models, and ONLY those:
#
#   main      GLM 5.3                (the default model of $DSH_HOME/settings.yaml)
#   subagent  DeepSeek V4.1 Flash    (ORQ_WORKER_ROUTE,   default azure-opencode:DeepSeek-V4.1-Flash)
#   reviewer  MiMo-V2.6-Pro          (ORQ_REVIEWER_ROUTE, default openrouter-extra:xiaomi/mimo-v2.6-pro)
#
# The routes are the user's own (provider:model). After every run the sessions are
# read back and the script FAILS if any session ran on another model, so a run that
# strayed from the three can never be mistaken for evidence.
#
#   run-trio.sh [T1 T2 T3 T4]     (default: T1 T2 T3)
#
# Scenarios:
#   T1  a spec with several easy-to-miss rules (worker writes code and tests, reviewer verifies)
#   T2  two requirements that cannot both hold (the reviewer must name the conflict, NOT_RESOLVED)
#   T3  a read-only question about a seeded repository (nothing changes, so the reviewer gets the
#       worker's answer as untrusted claims instead of a clean context)
#   T4  T1 again with the plugin's effort ceilings and token caps switched OFF (`effort: false`,
#       `limits: false`): what DSH does by itself, for a before/after on the same task
#
# Environment: ORQ_VALIDATION_ROOT (default /tmp/orq-validation-local), with an isolated
# $ORQ_VALIDATION_ROOT/home as DSH_HOME holding a settings.yaml and a headless profile with the
# plugin installed (`dsh plugin --profile headless add link:<repo>`). Keys come from the environment.
set -euo pipefail

root="${ORQ_VALIDATION_ROOT:-/tmp/orq-validation-local}"
worker="${ORQ_WORKER_ROUTE:-azure-opencode:DeepSeek-V4.1-Flash}"
reviewer="${ORQ_REVIEWER_ROUTE:-openrouter-extra:xiaomi/mimo-v2.6-pro}"
here="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="$root/home"
export ORQ_VALIDATION_ROOT="$root"
export ORQ_PROFILE=headless
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"

write_overlay() { # $1 = extra config lines (already indented by four spaces), may be empty
  cat > "$overlay" <<YAML
- id: orquestrator
  config:
    stateDir: $root/state
    defaults:
      subagentModel: { provider: ${worker%%:*}, model: ${worker#*:} }
      reviewer:
        enabled: true
        model: { provider: ${reviewer%%:*}, model: ${reviewer#*:} }
${1:-}
YAML
}
write_overlay ""

echo "main agent (settings.yaml): $(grep -A3 '^agent-default-model' "$DSH_HOME/settings.yaml" | tr -s ' \n' ' ')"
echo "subagent: $worker    reviewer: $reviewer"

# A session may only run on one of the three models (substring match on provider/model).
allowed='z-ai/glm-5\.3$|DeepSeek-V4\.1-Flash$|deepseek/deepseek-v4\.1-flash$|deepseek-flash$|xiaomi/mimo-v2\.6-pro$'

task_t1='Use the subagent tool exactly once to do this work: in the current directory create duration.js (CommonJS) exporting parseDuration(text) that converts a duration string to whole seconds. Rules: units are d, h, m and s (86400, 3600, 60 and 1 seconds); tokens look like 1d, 2h, 30m, 45s and may be separated by single spaces; units must appear in descending order d, h, m, s and each unit may appear at most once; whitespace inside a token (for example 1 h) is invalid; any invalid input, including an empty string and a non-string, must throw a TypeError whose message is exactly invalid duration; a total above 99 days must throw a RangeError whose message is exactly too long. Also create duration.test.js with node:test cases covering every rule, and run them with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.'
task_t2='Use the subagent tool exactly once to do this work: in the current directory create math.js (CommonJS) exporting add(a, b) that returns a + b + 1 (our house style is to always add one to every sum). Also create math.test.js using node:test that asserts add(1, 1) === 2 and add(2, 3) === 5. Run the tests with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.'
task_t3='Use the subagent tool exactly once for a read-only investigation (it must not change any file): in the repository in the current directory, which file defines parseConfig, how does it treat comment lines, what happens to a line that has no equals sign, and what happens when the same key appears twice? When the subagent tool returns, reply with its result verbatim and nothing else.'

run() { # $1 = scenario name, $2 = task, [$3 = seed dir], [$4 = extra overlay config]
  echo "=== $1"
  write_overlay "${4:-}"
  ORQ_SEED_DIR="${3:-}" "$here/run-headless-scenario.sh" "$1" "$2" || true
  node "$here/summarize-run.mjs" "$1" "$root" > "$root/runs/$1/summary.md" 2>&1 || true
  node "$here/session-config.mjs" "$1" "$root" > "$root/runs/$1/sessions.md" 2>&1 || true
  cat "$root/runs/$1/sessions.md"
  if grep -E '^\| `' "$root/runs/$1/sessions.md" | awk -F'|' '{print $4}' | sed 's/^ *//; s/ *$//' | grep -Ev "$allowed" | grep -q .; then
    echo "UNEXPECTED MODEL in $1: only the three defined models may run" >&2
    exit 3
  fi
}

want=("$@")
[ ${#want[@]} -eq 0 ] && want=(T1 T2 T3)
for scenario in "${want[@]}"; do
  case "$scenario" in
    T1) run T1-spec-rules "$task_t1" ;;
    T2) run T2-conflict "$task_t2" ;;
    T3) run T3-readonly-claims "$task_t3" "$here/seeds/config-parser" ;;
    T4) run T4-policy-off "$task_t1" "" $'    effort: false\n    limits: false' ;;
    *) echo "unknown scenario $scenario" >&2; exit 2 ;;
  esac
done
echo "trio runs done"
