#!/usr/bin/env bash
# The consistent management surface for callbench's Modal endpoints.
#
# One command per operation over the fleet. The endpoint list and the app-name
# prefix are single-sourced (the prefix is read from common.py, not re-typed),
# so a rename in common.py can't leave this script targeting the old name.
#
#   ./manage.sh deploy [role]   deploy the default fleet, or one <role>
#   ./manage.sh status          modal app list, then GET /health per endpoint
#   ./manage.sh urls            print each endpoint's live base URL
#   ./manage.sh logs <role>     tail one endpoint's logs
#   ./manage.sh down [role]     stop the fleet, or one <role>
#
# Endpoints scale to zero on their own; `down` is a deliberate stop, not cost
# control. `modal` is the uv-tool CLI already on PATH.
set -euo pipefail
cd "$(dirname "$0")"

# Single source of truth. PREFIX comes from common.py (retire-a-name-everywhere:
# never re-type a name another file declares). ALL is every deployable endpoint;
# DEFAULT is what a bare `deploy`/`down` touches — llm is EXCLUDED because it is
# deliberately not deployed until the persona needs it (infra/modal/README.md),
# so deploy-all must never spend a GPU on it by surprise.
PREFIX="$(sed -n 's/^PREFIX = "\(.*\)"/\1/p' common.py)"
[ -n "$PREFIX" ] || { echo "could not read PREFIX from common.py"; exit 1; }
WORKSPACE="$(modal profile current 2>/dev/null || true)"
declare -a ALL=("stt" "tts" "llm")
declare -a DEFAULT=("stt" "tts")

# The web-function tag Modal derives from each endpoint's source: a class's asgi
# method (STT.api -> "stt-api") or a bare function (serve -> "serve"). Modal's
# CLI does not expose deployed URLs, but they are deterministic, so we
# reconstruct them. A `case` (not an associative array) because macOS ships
# bash 3.2, which has no `declare -A`.
web_tag() {
  case "$1" in
    stt) echo "stt-api" ;;
    tts) echo "tts-api" ;;
    llm) echo "serve" ;;
    *) echo "" ;;
  esac
}

file_for() { echo "$1.py"; }
app_for() { echo "${PREFIX}-$1"; }

# Is a role currently deployed? (app list's `description` holds the app name.)
is_deployed() { modal app list --json 2>/dev/null | python3 -c "
import json,sys
app=sys.argv[1]
print(any(a.get('description')==app and a.get('state','').lower()=='deployed'
          for a in json.load(sys.stdin)))" "$(app_for "$1")" 2>/dev/null; }

# The deterministic public URL for a deployed role, or empty if not deployed.
url_for() {
  [ "$(is_deployed "$1")" = "True" ] || return 0
  echo "https://${WORKSPACE}--${PREFIX}-$1-$(web_tag "$1").modal.run"
}

roles_or() { if [ -n "${1:-}" ]; then echo "$1"; else printf '%s\n' "${@:2}"; fi; }

cmd="${1:-}"; arg="${2:-}"
case "$cmd" in
  deploy)
    # bare deploy -> DEFAULT (no llm); an explicit role deploys exactly that.
    for role in $(roles_or "$arg" "${DEFAULT[@]}"); do
      echo "== deploying $role ($(file_for "$role")) =="
      modal deploy "$(file_for "$role")"
    done
    echo "done. ./manage.sh urls for the base URLs; llm deploys only on request."
    ;;

  status)
    modal app list
    echo
    for role in "${ALL[@]}"; do
      url="$(url_for "$role" | head -1)"
      if [ -z "$url" ]; then
        echo "  $role: not deployed"
      else
        # curl's -w always prints the code (000 on a connect failure); no `|| echo`
        # (that would double it). A short timeout means a scaled-down endpoint
        # reads 000 — that is "not warm right now", a cold start, not "down".
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/health" 2>/dev/null)"
        echo "  $role: $url/health -> ${code:-000} $([ "${code:-000}" = 200 ] && echo OK || echo '(cold or spinning)')"
      fi
    done
    ;;

  urls)
    for role in "${ALL[@]}"; do
      url="$(url_for "$role" | head -1)"
      [ -n "$url" ] && echo "$role: $url" || echo "$role: (not deployed)"
    done
    ;;

  logs)
    [ -n "$arg" ] || { echo "usage: ./manage.sh logs <role>"; exit 1; }
    modal app logs "$(app_for "$arg")"
    ;;

  down)
    for role in $(roles_or "$arg" "${ALL[@]}"); do
      echo "== stopping $role =="
      modal app stop "$(app_for "$role")" || echo "  (not running)"
    done
    ;;

  *)
    sed -n '2,15p' "$0"
    exit 1
    ;;
esac
