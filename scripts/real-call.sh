#!/usr/bin/env bash
# THE REAL CALL — one command, zero flags to remember.
#
# Everything is pre-wired: the rehearsed persona scenario, the streaming
# runner, caller-yield politeness, both judged rubrics. The script below will
# print the target number and stop; the ONLY thing to do is type the
# confirmation it asks for (DIAL + the number's last four digits). One call,
# no retry; freeze, grading, and the dashboard entry are automatic after
# hangup. If a HUMAN answers instead of the AI agent: the call is a test —
# identify it as one and end it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec env CALLBENCH_PERSONA_RUNNER=openai:Qwen/Qwen3-4B-Instruct-2507 \
  node --env-file=.env scripts/live-scenario.ts \
  --scenario windshield-quote-persona --persona --target --bench-barge-in yield
