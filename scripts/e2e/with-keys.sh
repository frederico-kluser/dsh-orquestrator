#!/usr/bin/env bash
# Run a command with ONLY the API keys a live validation needs, and nothing else secret.
#
#   with-keys.sh <command> [args...]
#
# A live run starts a DSH whose agents have a bash tool: whatever is in the process
# environment is readable by a model. This wrapper therefore
#   1. loads the user's environment the way a login shell does (~/.zshenv sources ~/.secrets),
#   2. keeps the two keys the three target models need (override with ORQ_KEYS="A B"),
#   3. unsets every other exported variable that is not on a short allow-list,
#   4. execs the command.
# Values are never printed. It exits 4 when a required key is not set after step 1.
set -euo pipefail

keys="${ORQ_KEYS:-OPENROUTER_API_KEY AZURE_OPENCODE_API_KEY}"

set +u
set -a
# shellcheck disable=SC1091
[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv" > /dev/null 2>&1 || true
set +a
set -u

declare -A keep=()
for key in $keys; do
  value="${!key:-}"
  if [ -z "$value" ]; then
    echo "with-keys: $key is not set after loading ~/.zshenv" >&2
    exit 4
  fi
  keep[$key]="$value"
done

allow='^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR|TMP|TEMP|PWD|OLDPWD|SHLVL|NVM_[A-Z_]+|NODE_OPTIONS|XDG_[A-Z_]+|DSH_HOME|ORQ_[A-Z_]+|_)$'
while IFS= read -r name; do
  [[ "$name" =~ $allow ]] || unset "$name" 2> /dev/null || true
done < <(compgen -e)

for key in "${!keep[@]}"; do
  export "$key=${keep[$key]}"
done
unset keep value key keys allow name

exec "$@"
