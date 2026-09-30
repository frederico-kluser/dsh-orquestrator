#!/usr/bin/env bash
# Scenario F: a planted defect. The request asks the worker for an implementation
# structure that is wrong for one input (15) and forbids it from creating or
# running tests, so nothing in the worker's turn can expose the bug. A reviewer
# that follows its protocol must write its own check, see it fail, fix the code
# minimally and report APPROVED_WITH_FIXES (or report the contradiction).
# Runs after run-final.sh (all runners share the profile overlay).
set -euo pipefail
root="${ORQ_VALIDATION_ROOT:-/Volumes/Ext2TB/dsh-orq-validation}"
export DSH_HOME="$root/home"
overlay="$DSH_HOME/profiles/headless/cordis.patch.yml"
here="$(cd "$(dirname "$0")" && pwd)"
for _ in $(seq 1 480); do
  grep -q "final done" "$root/final.out" 2>/dev/null && break
  sleep 10
done
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
task='Use the subagent tool exactly once to do this work: in the current directory create fizzbuzz.js (CommonJS) exporting fizzbuzz(n), which returns an array with the results for the numbers 1 to n: "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for multiples of both, otherwise the number itself. Follow our house style exactly: one if / else-if chain that tests n % 3 first, then n % 5, then n % 15, and otherwise returns the number. Do not create any test files and do not run anything: a separate CI step covers tests. When the subagent tool returns, reply with its result verbatim and nothing else.'
"$here/run-headless-scenario.sh" F-planted-defect "$task" || true
echo "f done"
