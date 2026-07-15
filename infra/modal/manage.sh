#!/usr/bin/env bash
# The consistent management surface for callbench's Modal endpoints.
#
# One command for every operation, over ALL endpoints at once, so managing the
# fleet is never a matter of remembering which file is which app. The endpoint
# list is the single source of truth below; adding a *.py endpoint means adding
# one line here.
#
#   ./manage.sh deploy [role]   deploy all endpoints, or just <role>
#   ./manage.sh status          modal app list + a /health probe per live URL
#   ./manage.sh urls            print each endpoint's base URL (for .env)
#   ./manage.sh logs <role>     tail one endpoint's logs
#   ./manage.sh down [role]     stop all endpoints, or just <role> (idle is
#                               already $0; this releases immediately)
#
# `modal` is the uv-tool CLI already on PATH. Endpoints scale to zero on their
# own — `down` is for a deliberate stop, not cost control.
set -euo pipefail
cd "$(dirname "$0")"

# role -> source file. The one place the fleet is enumerated.
declare -a ROLES=("stt" "tts" "llm")
file_for() { echo "$1.py"; }
app_for() { echo "callbench-$1"; }

roles_or_arg() { if [ -n "${1:-}" ]; then echo "$1"; else printf '%s\n' "${ROLES[@]}"; fi; }

cmd="${1:-}"; arg="${2:-}"
case "$cmd" in
  deploy)
    for role in $(roles_or_arg "$arg"); do
      echo "== deploying $role ($(file_for "$role")) =="
      modal deploy "$(file_for "$role")"
    done
    echo "done. run ./manage.sh urls to get the base URLs for .env"
    ;;

  status)
    modal app list
    ;;

  urls)
    # A deployed web endpoint's URL is stable per (workspace, app, function).
    # Modal prints it on deploy; this reconstructs the lookup via `modal app`.
    for role in "${ROLES[@]}"; do
      echo "== $role =="
      modal app list 2>/dev/null | grep -q "$(app_for "$role")" \
        && echo "  deployed — URL was printed on its last deploy; re-run: modal deploy $(file_for "$role")" \
        || echo "  not deployed"
    done
    echo
    echo "The canonical URL is what 'modal deploy' prints. Copy it into .env as"
    echo "the matching MODAL_*_URL (see .env.example)."
    ;;

  logs)
    [ -n "$arg" ] || { echo "usage: ./manage.sh logs <role>"; exit 1; }
    modal app logs "$(app_for "$arg")"
    ;;

  down)
    for role in $(roles_or_arg "$arg"); do
      echo "== stopping $role =="
      modal app stop "$(app_for "$role")" || echo "  (not running)"
    done
    ;;

  *)
    sed -n '2,20p' "$0"  # print the header help
    exit 1
    ;;
esac
