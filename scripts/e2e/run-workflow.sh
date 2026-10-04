#!/usr/bin/env bash
# Headless validation of the start guard on the three target models, and ONLY those:
#
#   main      GLM 5.3                (the default model of $DSH_HOME/settings.yaml)
#   subagent  DeepSeek V4.1 Flash    (ORQ_WORKER_ROUTE,   default azure-opencode:DeepSeek-V4.1-Flash)
#   reviewer  MiMo-V2.6-Pro          (ORQ_REVIEWER_ROUTE, default openrouter-extra:xiaomi/mimo-v2.6-pro)
#
# Scenarios (every one asks the main agent to call the `workflow` tool once with a fixed script):
#   W0  the 0.3.0 plugin (profile `before`), two agents with no model of their own: the BUG, reproduced:
#       the agents run on the main agent's model at its effort, as they did for the user
#   W1  the same task on the current plugin (profile `headless`): the agents run on the picked
#       subagent model under the effort ceiling and the token cap; no reviewer is started for them
#   W2  one agent names MiMo itself, one names nothing: `explicitModel: override` (the default) puts both on the pick
#   W3  the same script with `children: { explicitModel: keep }`: the named model stands, under the ceilings
#   W4  `children: false` (the 0.3 behavior, switched off on purpose): the agents run on the main model again
#   W6  a confirmed subagent model that the LLM runtime no longer knows (azure-opencode:Retired-Model-9, never
#       called): the start is rejected with a message that names it, the workflow fails loudly, and no child
#       session exists, instead of every agent failing into a silent null or running on the main agent's model
#   W7  the same dead model, through the `subagent` tool instead of a workflow: the tool result is the same actionable
#       message, not a bare "subagent run failed"
#   W5  not a workflow: the `subagent` tool in the background (`continuable`, the standard preset's default),
#       model only (reviewer off). The plugin's own pipeline starts that child, through the same door the guard
#       stands in, so this is the check that the guard leaves it alone and it runs on the pick, once planned
#
#   run-workflow.sh [W0 W1 W2 W3 W4 W5 W6 W7]     (default: W0 W1 W2 W3 W5 W6 W7)
#
# Run ONE script at a time: every scenario rewrites the profile's cordis.patch.yml, so two at once (a run-trio.sh
# next to this one) hand each other's overlay to the DSH that boots second.
#
# Run it through scripts/e2e/with-keys.sh so only the two needed keys reach the agents:
#   scripts/e2e/with-keys.sh scripts/e2e/run-workflow.sh W0 W1
#
# Environment: ORQ_VALIDATION_ROOT (default <repo>/.validation-tmp/orq-validation-local) holding an isolated `home/`
# (DSH_HOME) with a settings.yaml and the profiles `headless` (current plugin) and `before` (the previous build).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
root="${ORQ_VALIDATION_ROOT:-$repo/.validation-tmp/orq-validation-local}"
worker="${ORQ_WORKER_ROUTE:-azure-opencode:DeepSeek-V4.1-Flash}"
reviewer="${ORQ_REVIEWER_ROUTE:-openrouter-extra:xiaomi/mimo-v2.6-pro}"
export DSH_HOME="$root/home"
export ORQ_VALIDATION_ROOT="$root"

scenario_worker="$worker"

write_overlay() { # $1 = profile, $2 = extra config lines (already indented by four spaces), may be empty, $3 = reviewer on (default) or off
  local reviewer_block
  if [ "${3:-on}" = "off" ]; then
    reviewer_block="      reviewer: { enabled: false }"
  else
    reviewer_block="      reviewer:
        enabled: true
        model: { provider: ${reviewer%%:*}, model: ${reviewer#*:} }"
  fi
  cat > "$DSH_HOME/profiles/$1/cordis.patch.yml" <<YAML
- id: orquestrator
  config:
    stateDir: $root/state
    defaults:
      subagentModel: { provider: ${scenario_worker%%:*}, model: ${scenario_worker#*:} }
$reviewer_block
${2:-}
YAML
}

# A session may only run on one of the three models (substring match on provider/model).
allowed='z-ai/glm-5\.3$|DeepSeek-V4\.1-Flash$|deepseek/deepseek-v4\.1-flash$|deepseek-flash$|xiaomi/mimo-v2\.6-pro$'

read -r -d '' task_w1 <<'TASK' || true
Use the workflow tool exactly once, with exactly this meta and exactly this script, and change nothing in them.

meta: {"name":"echo-two","description":"Ask two agents for one word each","phases":[{"title":"Ask"}]}

script:
const words = await parallel([
  () => agent('Reply with exactly the single word ALPHA and nothing else.', { label: 'alpha', phase: 'Ask' }),
  () => agent('Reply with exactly the single word BETA and nothing else.', { label: 'beta', phase: 'Ask' }),
])
return words

When the workflow tool returns, reply with its result verbatim and nothing else.
TASK

read -r -d '' task_w2 <<'TASK' || true
Use the workflow tool exactly once, with exactly this meta and exactly this script, and change nothing in them.

meta: {"name":"echo-named","description":"Ask two agents for one word each, one of them naming its own model","phases":[{"title":"Ask"}]}

script:
const words = await parallel([
  () => agent('Reply with exactly the single word GAMMA and nothing else.', { label: 'gamma', phase: 'Ask', provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro' }),
  () => agent('Reply with exactly the single word DELTA and nothing else.', { label: 'delta', phase: 'Ask' }),
])
return words

When the workflow tool returns, reply with its result verbatim and nothing else.
TASK

read -r -d '' task_w5 <<'TASK' || true
Use the subagent tool exactly once, with run_in_background set to true, for this read-only question: "In one short sentence, what is the capital of France? Do not use any tool." Right after it starts, run `sleep 60` in bash so the background agent can finish, and then reply with exactly the word: done
TASK

read -r -d '' task_w7 <<'TASK' || true
Use the subagent tool exactly once, with run_in_background set to false, to answer this question: "What is 2 plus 2?" When the subagent tool returns, reply with its result verbatim and nothing else.
TASK

run() { # $1 = scenario name, $2 = profile, $3 = task, [$4 = extra overlay config], [$5 = reviewer on|off]
  echo "=== $1 (profile $2)"
  write_overlay "$2" "${4:-}" "${5:-on}"
  ORQ_PROFILE="$2" ORQ_TIMEOUT_SECONDS="${ORQ_TIMEOUT_SECONDS:-900}" "$here/run-headless-scenario.sh" "$1" "$3" || true
  node "$here/summarize-run.mjs" "$1" "$root" > "$root/runs/$1/summary.md" 2>&1 || true
  node "$here/session-config.mjs" "$1" "$root" > "$root/runs/$1/sessions.md" 2>&1 || true
  grep -h "dsh-orquestrator" "$root/runs/$1/stderr.log" > "$root/runs/$1/plugin-log.txt" 2>&1 || true
  cat "$root/runs/$1/sessions.md"
  echo "--- plugin log lines:"; cat "$root/runs/$1/plugin-log.txt" 2>/dev/null | cut -c1-260 || true
  if grep -E '^\| `' "$root/runs/$1/sessions.md" | awk -F'|' '{print $4}' | sed 's/^ *//; s/ *$//' | grep -Ev "$allowed" | grep -q .; then
    echo "UNEXPECTED MODEL in $1: only the three defined models may run" >&2
    exit 3
  fi
}

want=("$@")
[ ${#want[@]} -eq 0 ] && want=(W0 W1 W2 W3 W5 W6 W7)
for scenario in "${want[@]}"; do
  case "$scenario" in
    W0) run W0-before-bug before "$task_w1" ;;
    W1) run W1-workflow-governed headless "$task_w1" ;;
    W2) run W2-explicit-override headless "$task_w2" ;;
    W3) run W3-explicit-keep headless "$task_w2" $'    children: { explicitModel: keep }' ;;
    W4) run W4-guard-off headless "$task_w1" $'    children: false' ;;
    W5) run W5-background-continuable headless "$task_w5" "" off ;;
    W6) scenario_worker='azure-opencode:Retired-Model-9'; run W6-confirmed-model-gone headless "$task_w1" "" off; scenario_worker="$worker" ;;
    W7) scenario_worker='azure-opencode:Retired-Model-9'; run W7-subagent-tool-model-gone headless "$task_w7" "" off; scenario_worker="$worker" ;;
    *) echo "unknown scenario $scenario" >&2; exit 2 ;;
  esac
done
echo "workflow runs done"
