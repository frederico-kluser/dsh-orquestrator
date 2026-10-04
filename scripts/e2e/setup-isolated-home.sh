#!/usr/bin/env bash
# Prepare the isolated DSH_HOME the live validations run in. Idempotent: it rebuilds the home each time.
#
#   scripts/e2e/with-keys.sh scripts/e2e/setup-isolated-home.sh
#
# Creates under ORQ_VALIDATION_ROOT (default <repo>/.validation-tmp/orq-validation-local, which git ignores):
#   home/settings.yaml        the user's settings.yaml, copied VERBATIM, with only two blocks replaced as text:
#                             the main agent (GLM 5.3 at `high`; at `max` it stalled for minutes) and the permission
#                             preset (`workspace-write`, not the user's `danger-full-access`)
#   home/profiles/headless    the headless profile with THIS working tree installed (`link:`): the plugin under test
#   home/profiles/before      the headless profile with the previous build (ORQ_BEFORE_REF, default 487e720, 0.3.0)
#   plugin-before/            that previous build, extracted without node_modules
#   runs/, state/             run evidence and the plugin's state directory
#
# The live DSH on the user's machine is never touched: nothing here reads or writes ~/.dsh except the one
# read-only copy of settings.yaml, which holds variable NAMES (apiKeyEnv), never key values.
#
# Never round-trip settings.yaml through a YAML library. YAML 1.1 reads the `off:` key of a reasoning ladder as the
# boolean false and writes it back as `false:`; llm-pi-ai then rejects its own configuration and every provider is
# left without an adapter (`NO_ADAPTER: no adapter registered for provider "openrouter"`). That cost a run once.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
root="${ORQ_VALIDATION_ROOT:-$repo/.validation-tmp/orq-validation-local}"
source_settings="${ORQ_SETTINGS_SOURCE:-$HOME/.dsh/settings.yaml}"
before_ref="${ORQ_BEFORE_REF:-487e720}"
export DSH_HOME="$root/home"

mkdir -p "$root/runs" "$root/state" "$DSH_HOME/profiles"

python3 - "$source_settings" "$DSH_HOME/settings.yaml" <<'PY'
import re
import sys

source, target = sys.argv[1:3]
text = open(source, encoding="utf-8").read()

def replace_block(text: str, key: str, body: str) -> str:
    """Replace one top-level YAML block (the key line and its indented lines) by text, or append it."""
    pattern = re.compile(rf"(?m)^{re.escape(key)}:[ \t]*\n(?:[ \t]+[^\n]*\n)+")
    block = f"{key}:\n{body}"
    return pattern.sub(lambda _: block, text, count=1) if pattern.search(text) else text.rstrip("\n") + "\n" + block

text = replace_block(text, "agent-default-model", "  provider: openrouter\n  model: z-ai/glm-5.3\n  reasoningEffort: high\n")
text = replace_block(text, "permission", "  defaultPreset: workspace-write\n")
open(target, "w", encoding="utf-8").write(text)
PY
chmod 600 "$DSH_HOME/settings.yaml"

# Two profiles from the user's own headless template (bundles only), each with the plugin linked in.
rm -rf "$DSH_HOME/profiles/headless" "$DSH_HOME/profiles/before" "$root/plugin-before"
for profile in headless before; do
  mkdir -p "$DSH_HOME/profiles/$profile"
  cp "$HOME/.dsh/profiles/headless/package.json" "$HOME/.dsh/profiles/headless/pnpm-workspace.yaml" "$DSH_HOME/profiles/$profile/"
  printf '[]\n' > "$DSH_HOME/profiles/$profile/cordis.patch.yml"
done

mkdir -p "$root/plugin-before"
git -C "$repo" archive "$before_ref" | tar -x -C "$root/plugin-before"
echo "before: $(grep -m1 '"version"' "$root/plugin-before/package.json" | tr -d ' ,') ($before_ref)"

dsh plugin --profile headless add "link:$repo" > /dev/null
dsh plugin --profile before add "link:$root/plugin-before" > /dev/null

echo "after:  $(grep -m1 '"version"' "$repo/package.json" | tr -d ' ,') (this working tree)"
echo "main agent: $(grep -A3 '^agent-default-model' "$DSH_HOME/settings.yaml" | tr -s ' \n' ' ')"
echo "isolated home ready: $DSH_HOME"
