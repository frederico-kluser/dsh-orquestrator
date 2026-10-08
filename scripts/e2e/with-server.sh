#!/usr/bin/env bash
# Run a command against a throwaway `dsh --profile web` on an ISOLATED DSH home: never the operator's own ~/.dsh, never the
# port their GUI uses. The server is started for that command and stopped when the command ends, whatever it exits with.
# Its token lives in a 0600 log only — never echoed here, never to be printed by a caller.
#
#   scripts/e2e/with-server.sh <command> [args...]
#
# The command runs from the REPOSITORY ROOT (so `node scripts/e2e/ui-e2e.mjs` works) and sees:
#   DSH_URL           authenticated web URL of that throwaway server (per-process token — do not print or store it)
#   DSH_HOME          <root>/home, the isolated home (its settings.yaml is a COPY of the operator's, never theirs)
#   ORQ_SESSIONS_DIR  <root>/home/sessions, where the phase scripts read the session logs (`zstd -dc` must be on PATH)
#   ORQ_ROOT          <root>, so a nested helper resolves the same scratch tree
# PHASE, STEPS, OUT_DIR and CHROME_PATH are read from the environment by those scripts; the server is given only the API keys
# `with-keys.sh` allows, so an agent in a live run cannot read anything else of the operator's environment.
#
# `root` is `<repo>/.validation-tmp/orq-validation-local` (git-ignored) unless `ORQ_ROOT` says otherwise: one root per
# concurrent run, because two servers must not share a state dir. The home comes from
# `ORQ_VALIDATION_ROOT=<root> scripts/e2e/with-keys.sh scripts/e2e/setup-isolated-home.sh`.
# bash >= 4 is required (macOS ships 3.2 as /bin/bash): `with-keys.sh` uses `declare -A`, so run this with a newer bash first
# on PATH. The server starts in a scratch git workspace under `<root>/ws`, never in the repository.
#
#   scripts/e2e/with-server.sh node scripts/e2e/ui-e2e.mjs
#   PHASE=command OUT_DIR=.validation-tmp/out-command scripts/e2e/with-server.sh node scripts/e2e/ui-e2e.mjs
#   STEPS=child PHASE=skill OUT_DIR=.validation-tmp/out-skill scripts/e2e/with-server.sh node scripts/e2e/ui-e2e-skill.mjs
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/e2e/with-server.sh <command> [args...]

Runs <command> from the repository root against a throwaway `dsh --profile web` on an isolated DSH home
(started with `--no-open --port 0`, stopped when the command ends). The command sees DSH_URL (per-process
token: never print it), DSH_HOME, ORQ_SESSIONS_DIR and ORQ_ROOT.

  ORQ_ROOT   scratch root, default <repo>/.validation-tmp/orq-validation-local

Needs a home built by scripts/e2e/setup-isolated-home.sh and bash >= 4 (`with-keys.sh`).
USAGE
}

if [ "$#" -eq 0 ]; then
  usage
  exit 2
fi
case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
root="${ORQ_ROOT:-$repo/.validation-tmp/orq-validation-local}"
export DSH_HOME="$root/home"
[ -d "$DSH_HOME" ] || { echo "with-server: $DSH_HOME does not exist; run: ORQ_VALIDATION_ROOT=$root scripts/e2e/with-keys.sh scripts/e2e/setup-isolated-home.sh" >&2; exit 3; }
mkdir -p "$root/ws"
log="$root/server.log"
: > "$log"; chmod 600 "$log"
if [ ! -d "$root/ws/.git" ]; then
  git -C "$root/ws" init -q -b main
  git -C "$root/ws" config user.email "validation@example.invalid"
  git -C "$root/ws" config user.name "orq validation"
  printf '# scratch workspace for the browser validation\n' > "$root/ws/README.md"
  git -C "$root/ws" add -A && git -C "$root/ws" commit -q -m "chore: initial workspace"
fi
cd "$root/ws"
"$repo/scripts/e2e/with-keys.sh" dsh --profile web --no-open --port 0 > "$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  url="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$log" | head -1 || true)"
  [ -n "$url" ] && break
  kill -0 "$server" 2>/dev/null || { echo "with-server: dsh exited early (see $log, token not shown)" >&2; exit 3; }
  sleep 0.5
done
[ -n "${url:-}" ] || { echo "with-server: no URL after 60 s" >&2; exit 3; }
export DSH_URL="$url"
export ORQ_SESSIONS_DIR="$DSH_HOME/sessions"
export ORQ_ROOT="$root"
cd "$repo"
"$@"
