# Competitive research: voice-agent testing & multi-turn AI evaluation products

Research date: 2026-07-15. Purpose: map the products adjacent to callbench — what
they do (feature landscape), how their UIs are structured, which open-source
projects we can study, and a distilled list of good ideas. End goal: inform the
look and feel of callbench's web UI.

All product claims below are vendor claims from the cited pages unless marked as
third-party. Vendor-authored comparison posts (Coval-vs-X, Bluejay-vs-Roark) are
flagged where used — treat competitor-authored numbers as claims, not facts.

---

## 1. The landscape

Two lineages converge on this market:

- **Dev-tool testing** (Hamming, Cekura, Coval, Roark, Bluejay, Relyable, Chanl,
  Voicetest): scenarios, personas, CI gates, replay, OpenTelemetry traces.
- **Contact-center QA** (Observe.AI, Level AI, evaluagent, Cyara, Hammer):
  scorecards/rubrics, human calibration loops, "same rubric for humans and bots".

Plus platform-native testing (Vapi, Retell, LiveKit) — text/LLM-layer-first,
cheap, single-platform — and general LLM-eval platforms extending into voice
(Maxim, Braintrust) or staying text-only (Langfuse, DeepEval, MLflow).

### Product index

| Product | Type | Pricing | One-liner |
|---|---|---|---|
| Hamming AI (YC S24) | Dedicated voice-agent QA | Contact sales | Audio-native evals, scenario auto-gen from prompt, 50K+ concurrent claim, production replay |
| Cekura (YC F24, ex-Vocera) | Dedicated voice-agent QA | $30/mo self-serve | Conditional Actions scripted tests, mock tools, judge-optimization labs, transparent credits |
| Coval (YC S24, $31M) | Dedicated voice-agent QA | $100/$500/$4.5k/mo | Waymo-style simulation framing, human-review flywheel, agent mutations, richest analytics |
| Roark (YC W25) | Simulation + observability | $0 PAYG/$500/$4k+/mo | Audio-native metrics (64+ emotions, DNSMOS), call replay w/ caller voice cloning, flow-graph authoring |
| Bluejay (YC X25, $4M) | Voice/chat/text QA | Private, usage-based | Digital Humans, Bluejay-as-Code (Terraform-style), MCP server, cross-call Customer Journeys |
| Relyable | Simulation + monitoring | $500/$1k/mo | Weighted rubric w/ 7-day deltas; persona×scenario Matrix Mode; solo-founder, currently closed to signups |
| Chanl (→ channel.tel) | Testing + monitoring | Free tier | Persona×agent test matrix, quality gates with automatic rollback, live listen-in |
| TestMu AI (ex-LambdaTest) | QA cloud w/ voice line | Tiered | Scenario gen from Jira/Confluence/PRDs, 30+ telephony metrics, Go-Live verdict (green/yellow/red) |
| TestAI (nbulatest.ai) | No-code agent testing | $0/$40/$124/mo | Prompt-leakage detection, A/B agent evaluation, anonymous try-before-signup |
| Bug0 | Managed QA service | $2,500/mo flat | Human forward-deployed engineer confirms every failure; Passmark OSS execution layer |
| Voice.ai testing | Enterprise voice QA page | Free tier claimed | "Synthetic Call Injection", Judge LLM vs golden dataset, Guardrail Engine alerts |
| Canonical AI | Production analytics only | $0 / $0.025/min | Sad Path Analysis, call-path "From Hello to Outcome", success-path anomaly detection |
| Cyara (incumbent) | CX assurance suite | Enterprise | Botium/Velocity/Cruncher + 2026 "agentic testing"; only vendor spanning media-plane to LLM-risk |
| Hammer (ex-Empirix) | Legacy IVR testing | Enterprise | Hammer Voice Explorer auto-crawls an IVR and generates its own test suite (the 2001-era ancestor) |
| Observe.AI / Level AI / evaluagent | Contact-center auto-QA | Enterprise | Scorecards, judge calibration sandboxes, graduated autonomy (auto-suggest/fill/submit) |
| Vapi (platform-native) | Test Suites → Evals → Simulations | Billed as calls | Mock-conversation evals, structured-output assertions, tool mocks, thumbs-down-to-eval |
| Retell (platform-native) | LLM-layer simulation | Included | Identity/Goal/Personality tester prompts, function mocking, batch testing history |
| LiveKit Agents (OSS) | pytest-based eval framework | Free | LLM-judge assertions next to unit tests; code-first, no dashboard |
| Maxim AI | LLM eval platform + voice sim | Tiered | Span/trace/session three-level evaluation; audio stats (SNR, talk ratio, speech rate) |
| Braintrust | LLM evals extended to voice | Tiered | Audio attached to traces, "replay what the agent heard"; Evalion caller-sim partner |
| Voicetest (OSS, Apache-2.0) | Cross-platform test harness | Free | Imports Retell/Vapi/Bland/LiveKit agent graphs into one IR; LLM judges; web UI |
| fixa (OSS, dormant) | Voice-agent testing + observe | Free | The open-source reference implementation; company pivoted, code frozen Jan 2025 |

Dead ends checked: **Klaudius** does not exist as a voice-testing product
(klaudius.ai fails DNS). **fixa** the company pivoted (fixa.dev now hosts an
unrelated product; repo dormant since v0.0.4, Jan 2025) — the code remains the
single most relevant OSS artifact.

---

## 2. Generalized feature model

The union of what these products do, organized as the anatomy every vendor
converges on. Common architecture: *AI tester agent converses with the target →
transcript + audio captured → judges score against criteria → pass/fail with
evidence.*

### 2.1 Test creation
- **Scenario/test-case authoring**: a behavioral prompt ("call to cancel
  Tuesday's appointment") + expected outcome + metrics. Names: Evaluator
  (Cekura), Customer Flow (Roark), Digital Human (Bluejay), Test Case (Coval).
- **Two authoring modes**: improvised (free-text brief, fresh conversation each
  run) vs scripted/deterministic (exact turns; Roark's DAG canvas, Cekura's
  Conditional Actions with an XML tag vocabulary — `<dtmf>`, `<silence>`,
  `<voicemail>`, `<background_noise>`, `<network_simulation>`…). Hybrid:
  Roark's "Preceded by" (scripted IVR prelude, then improv body).
- **Auto-generation**: from the agent's own system prompt (Hamming, Relyable),
  from transcripts/production calls (Roark "Ask Roark", Cekura Real-World
  Simulations), from PRDs/Jira/Confluence (TestMu), via API (Bluejay: 100
  Digital Humans from a description).
- **Personas**: reusable simulated-caller identities — language (up to 65
  claimed), accent, gender, pace, clarity, disfluencies, emotion, age.
  Persona libraries (200+ presets) and persona groups run as benchmark
  populations (Bluejay Communities).
- **Coverage matrices**: persona × scenario (Relyable Matrix Mode), persona ×
  agent (Chanl Cross-Product Test Matrix).
- **Test data**: reusable identity payloads for verification flows (Cekura Test
  Profiles with `{{date}}` variables), dynamic variables injected at runtime.
- **Tool mocks**: fake the agent's external tool calls so tests don't hit live
  APIs (Vapi Tool Mocks, Cekura Mock Tools with auto-fetch of tool definitions,
  Retell function mocking) — paired with a tool-call accuracy metric.
- **Multi-call journeys**: chained calls carrying state between steps (Bluejay
  Customer Journeys).

### 2.2 Simulation / execution
- Transport coverage: PSTN/Twilio/Telnyx, SIP (+ custom headers), WebRTC,
  WebSocket, LiveKit/Pipecat native, OpenAI Realtime, Gemini Live; chat, SMS,
  WhatsApp; inbound and outbound.
- Two-tier execution: cheap text/LLM-layer runs for iteration and CI, full
  audio telephony runs for end-to-end verification (Vapi webchat vs websocket,
  Retell LLM-layer, everyone's chat mode).
- Environmental simulation: background noise beds (office/café/airport,
  custom uploads), packet loss, DTMF, IVR menus, voicemail with beep timing,
  hold music, silence intervals, barge-in/interruption schedules.
- Voice cloning of real callers for replay (Roark launch feature, Bluejay).
- Concurrency as a headline number (claims: Cekura 2,000+, Hamming 50K+,
  Relyable "10,000x") and load testing as a distinct mode.
- Run bookkeeping: labeled runs (SR-{n}) with Queued→Running→Ended lifecycle,
  live listen-in on test calls, runs snapshotting the config they tested
  (Roark), attempts-per-test (Vapi 1–5, Braintrust Trials).
- Scheduling: cron/interval recurring runs (universally present — and exactly
  what callbench's dial gate forbids).

### 2.3 Evaluation
- **Three judge engines everywhere**: (1) deterministic (regex, exact match,
  comparators over structured outputs, latency thresholds); (2) LLM-judge
  (natural-language criteria; binary/scale/enum/JSON outputs); (3) formula/
  composite metrics over other metrics (no LLM cost).
- **Audio-native metrics** as the frontier differentiator (Roark, Hamming):
  judging the waveform, not the transcript — emotion (64+ classes), vocal
  stress, DNSMOS speech quality, pitch/pace/pauses, gibberish detection,
  pronunciation, accent stability, WER, barge-in handling, time-to-first-word,
  vocal fry, timbre drift, LUFS loudness (Coval's statistical set).
- Latency decomposed by pipeline stage (STT/LLM/TTS) with percentile
  aggregation (P50/P90/P95/P99).
- **Judge calibration as a product surface**: tune evaluation prompts against
  ground-truth recordings (Cekura "Optimize LLM Judges" Labs, Level AI
  sandbox, Observe.AI calibration, Coval Metric Review agreement rates).
- **Abstain states**: Cekura "Review Required" (automated evaluation cannot
  conclude → human override); Bluejay `allow_not_applicable`; Coval routes
  low-confidence to Human Review. The only precedents for callbench's
  INCONCLUSIVE, and none render it as a first-class verdict color.
- Red-teaming packs: prompt injection, jailbreak, PII leakage, bias/toxicity,
  multi-turn adversarial sequences.
- Root-cause clustering of failures into themes (Cekura Insights, Canonical
  Sad Path Analysis, Datadog Patterns).

### 2.4 Regression / CI
- GitHub Actions recipes gating merges on pass rate; version-controlled test
  definitions ("Bluejay as Code" — pull the whole estate as JSON, edit in git,
  push back); resource versioning with staleness flags on runs (Coval).
- Production-call-to-regression-test conversion in one click (Vapi thumbs-down
  → eval; Hamming Scenario Rerun; Cekura call action menu) — the loop every
  vendor emphasizes.
- Baseline freezing: 40–60 representative calls with audio + per-metric scores
  as the regression anchor (TestMu's method).

### 2.5 Production monitoring (out of callbench scope, noted for completeness)
- Ingest every production call (webhook/API/OTel), auto-score with the same
  metrics used pre-launch, threshold alarms with rolling windows, Slack/
  PagerDuty/email/webhook fan-out, golden-set replay as synthetic uptime
  checks (Hamming), anomaly detection anchored on historically-good call paths
  (Canonical).

### 2.6 Platform surfaces
- REST APIs with OpenAPI specs; Python/TS SDKs; CLIs; **MCP servers** (Cekura,
  Bluejay 60+ tools, Coval, Roark) and coding-agent "skills" — the newest
  competitive front is letting Claude/Cursor drive the QA platform.
- Embeddable white-label result views (Cekura embedding APIs, Canonical's
  React components) so agencies can resell reports.
- PDF/shareable reports for non-technical stakeholders (Hamming PDF reports,
  Coval public report links with revocable URLs).

---

## 3. UI structure — the extensive analysis

### 3.1 The canonical information hierarchy

Every product converges on the same five-level nesting, different nouns:

| Level | Voice tools | LLM tools | callbench |
|---|---|---|---|
| Workspace | org / agent | project | (project) |
| Definition | test suite / run plan | dataset + scorers | scenario + assertions |
| Execution | run / simulation | experiment | run |
| Unit | call / session | trace | call |
| Step | turn | span / observation | turn |

Top-level nav splits **pre-deploy** (Test/Simulate/Experiments) from
**post-deploy** (Monitor/Observe/Logs), with shared assets (personas, metrics,
datasets) as a third group. Coval names the loop in its nav: Simulate →
Observe → Review. Roark instead merges everything into one Call History with a
live-vs-simulation filter — one list, one detail page, a filter chip
distinguishing provenance.

### 3.2 The run-results table

- Rows = calls/cases. Columns = metadata (monospace call id, persona/scenario,
  duration, timestamp) + **one column per metric/criterion** — not a single
  verdict column. Hamming's headline is per-metric failure counts ("which
  assertion fails most"), not aggregate pass %.
- Aggregates live in the chrome, not the body: pass-rate stats in column
  headers (Braintrust), improved/regressed counts as clickable header chips
  (LangSmith), a stats strip above the table ("Pass rate 94.2% · Calls 1,248 ·
  Failures 3" — Coval; "Execution Overview" — Cekura).
- Verdict rendering: green check / red X universally; LangSmith's compare view
  adds the baseline-relative meaning (green = improved, red = regressed vs a
  named source experiment). **No product surveyed renders a third
  inconclusive state as a first-class color — open design territory for
  callbench's INCONCLUSIVE (amber/gray slot is free).**
- Rows expand in place or open a side drawer (Vapi per-attempt dropdown, Opik
  resizable drawer, Datadog side panels) — you never lose the table.
- Canned triage views: "Failures", "Errors", "Unreviewed" (Braintrust, Roark
  saved views). Filter state serialized to the URL with typed operators
  (`=`, `!=`, `contains:` — Roark; promptfoo `filterMode`/`search` params) so
  a filtered view is a shareable link.
- Flakiness surfaced structurally: attempts grouped under one test (Vapi),
  "Trials" column when rows share an input (Braintrust).

### 3.3 The call/trace detail page

Two dominant shapes:

1. **Tree + detail** (LLM lineage — Langfuse, LangSmith, Phoenix, Braintrust):
   left panel is the span/observation hierarchy with a **tree/timeline
   toggle** (same data, two projections, metric parity in both); right panel
   is the selected node's full I/O, latency, tokens, and judge reasoning.
   Phoenix embeds a duration bar in every tree row (Gantt-in-the-tree);
   Langfuse heat-colors tree nodes by latency/cost percentile *relative to
   siblings* — the slow turn jumps out with no thresholds configured.

2. **Verdicts + transcript + audio** (voice lineage — Coval's layout, the
   canonical one for callbench): **metric verdicts in a left rail, verdict
   detail center, speaker-diarized transcript right, waveform audio player
   docked full-width at the bottom.**

   Roark's alternative: five tabs over one call — Overview (AI summary + key
   stats) / Transcript (speaker + timestamps + tool-call annotations +
   sentiment overlay) / Metrics (call-, segment-, and turn-scoped) /
   Properties / Tools (every invocation with inputs, outputs, errors).

Transcript rendering is consistently *script-like*: speaker-labeled turns with
timestamps, denser than chat bubbles; tool calls and sentiment as inline
annotations on turns; per-turn latency attached to the turn row (Hamming
decomposes it into STT/LLM/TTS stacked segments).

### 3.4 Audio-transcript sync (the centerpiece pattern)

Assembled from fixa (source code read), Observe.AI, Label Studio, and the
ElevenLabs component registry:

- Waveform player with click-to-seek, playback speed (1/1.5/2x), zoom/minimap
  for long calls.
- **Bidirectional coupling**: playback highlights the current transcript line
  and auto-scrolls it into view under a sticky header; clicking a transcript
  line seeks the audio. One shared playhead drives both panes.
- **Event markers pinned to the waveform**: failed assertions, latency blocks,
  interruptions rendered as colored spans overlaid on the waveform. Clicking a
  finding seeks to its span, plays, and **auto-pauses when the span ends**
  (fixa's exact behavior). Hover state is lifted so waveform block and
  transcript chip highlight together.
- fixa renders **stereo split-channel waveforms** — agent on one channel band,
  caller on the other — so overlap/interruptions are visible in the waveform
  shape itself.
- Observe.AI's framing: evaluators jump between "key moments" instead of
  listening linearly — "evaluations five times faster".

### 3.5 Dashboards

- Recurring chart set: latency percentiles over time, pass-rate trend, call
  volume, cost, sentiment distribution. Stat tiles + trend lines beat exotic
  charts — Roark ships exactly two viz types (Line Graph, Number Chart).
- Universal interaction rule: **every aggregate drills down** to its
  underlying calls (Roark data-point click-through, Coval Top-list widgets).
- Distinctive: Relyable's weighted-rubric table (Criterion | Weight | Pass
  Rate | 7-day Δ with trend arrows) — the densest "is my agent getting
  better" artifact found; Coval Reports comparing up to 50 runs with
  P95/min/max aggregation and public share links.

### 3.6 Visual style

- Developer observability skews **dense, dark-or-dual-theme, monospace for
  ids/JSON/latency numbers** (Braintrust, Phoenix, Roark, Cekura). Langfuse
  ships both themes with a restrained shadcn/Tailwind aesthetic. Contact-
  center QA (Observe.AI, Level AI) is light and airy for non-engineers.
- Marketing mocks converge on: monospace call ids (`call_8a3f12`, `c_8f42`),
  one large numeric score per call ("91"), green/red verdict chips, scenario
  chips ("Angry caller · refund demand — pass · 92").
- Stack of choice for newer entrants: **shadcn/Tailwind idiom** (Langfuse,
  Opik, fixa, ElevenLabs UI, third-party Retell dashboards) — translates
  directly to callbench's SvelteKit + dense-table direction.
- Published UX doctrine (Hamel Husain's evals-tool essays, the most-cited
  design guidance in the space): the custom data viewer is the highest-ROI
  artifact; all context on one screen; one-click correct/incorrect rather
  than forms; hotkey navigation between examples; quick filter by failure
  mode. Critiques on record: LangSmith "cluttered"; Phoenix poor text
  readability; Braintrust clean nav but clunky data round-trips.

---

## 4. Open-source projects to study for UI

Ranked for "call-run review UI with synced audio + transcript + verdicts".
Stars approximate as of 2026-07-15.

1. **fixa-observe** — github.com/fixadev/fixa-observe (88★, frozen Jan 2025)
   and github.com/fixadev/fixa (117★, BSD-2). The same product category solved
   end-to-end. Next.js/tRPC/Prisma/shadcn/wavesurfer. Read
   `apps/web-app/src/components/dashboard/{AudioPlayer,CallDetails,AudioVisualizationBlock}.tsx`:
   stereo split-channel wavesurfer, verdict/latency/interruption spans overlaid,
   click-to-play-a-finding with auto-stop, time-derived active transcript turn
   with auto-scroll, editable latency blocks (human correction of machine
   timings, saved via mutation). Treat as a design document, not a dependency.
2. **Langfuse** — github.com/langfuse/langfuse (31.2k★, MIT core, active).
   Best-in-class IA for runs/traces/sessions/scores: three-pane trace detail,
   tree/timeline toggle, sibling-relative heat coloring, score chips,
   virtualized tables, annotation queues, sessions-as-chat, audio attachments
   (`LangfuseMediaView`). `docker compose up` to run.
3. **Opik** — github.com/comet-ml/opik (20.6k★, Apache-2.0, active). shadcn
   components you can actually lift: drawer-based review, thread view with
   feedback scores + reviewer comments, working audio player
   (`useAudioPlayer.ts`). Study the `v2` page tree.
4. **Label Studio** — github.com/HumanSignal/label-studio (27.8k★, Apache-2.0).
   The most mature waveform-region interaction design: labeled draggable
   regions, zoom, playhead, region list synced both ways; the
   "Paragraphs-synced-with-audio" template is exactly the transcript half of a
   call-review page. Custom canvas audio engine (they left wavesurfer for
   performance on long files).
5. **wavesurfer.js + hyperaudio-lite** — the two primitives bounding the
   design space. wavesurfer (10.3k★, BSD-3) Regions/Timeline/Minimap/Zoom
   plugins; hyperaudio-lite (168★, MIT) is ~300 lines of vanilla JS word-sync
   (`<span data-m="ms" data-d="dur">`) — read both before writing the player.
   Note fixa hand-rolled overlay divs instead of the Regions plugin: Regions
   gives drag/resize free; overlays give full styling + framework-state
   integration.
6. **promptfoo** — github.com/promptfoo/promptfoo (23.3k★, MIT). The verdict
   grammar: per-assertion pass/fail with expected/got/reason, failure-only
   filtering, matrix overview, cell-level human override. `npx promptfoo view`
   to experience in five minutes.
7. **Laminar** — github.com/lmnr-ai/lmnr (3.1k★, Apache-2.0). rrweb session
   replay synced to the span timeline — the structural twin of audio ↔
   transcript ↔ findings sync. Read `frontend/components/traces/session-player.tsx`.
8. **Arize Phoenix** — github.com/Arize-ai/phoenix (10.6k★, **ELv2 — patterns
   only, don't copy code**). Best OSS span waterfall and experiment-comparison
   layouts; annotator provenance (human/llm/code) on every judgment.
9. **pipecat voice-ui-kit** (380★, BSD-2) + **livekit agent-starter-react**
   (899★, MIT) — voice-native component vocabulary (visualizers, transcript
   overlays, console/metrics panels) in the Tailwind/shadcn idiom;
   live-session-oriented, not review-oriented.
10. Honorable mentions: **MLflow** (traces + Assessments — human and LLM
    judgments attached to conversation traces; uses wavesurfer for audio
    artifacts); **transcript-seeker** (72★, MIT — small, readable
    player+transcript reference); **Voicetest** (Apache-2.0 — cross-platform
    agent-graph import + LLM judges, the most direct fixa successor);
    **Evidently** (test-suite verdict cards with pass/fail/warning);
    **OpenAI realtime-console** (event-log pane — a call bench also has an
    event stream: dial, ring, turn, assertion).

Also: **ElevenLabs UI** (ui.elevenlabs.io) — an open shadcn-style registry
purpose-built for voice UIs: `Waveform`, `ScrollingWaveform`, `AudioScrubber`,
`StaticWaveform` (seed-based deterministic rendering — a stable waveform can be
derived from a frozen artifact), `Transcript Viewer`, `Conversation`. The
closest published design system to callbench's domain.

Negative findings: vocode/bolna/DeepEval ship no OSS UI; Braintrust/LangSmith
closed (patterns only); Lunary's repo was pulled; audino is CC BY-NC (look,
don't copy).

---

## 5. Good ideas — the master list

Deduplicated across all reports; source in parentheses. Grouped by what they'd
touch in callbench.

### The call review page (the centerpiece)
1. **Metrics-left, transcript-right, waveform-bottom layout** (Coval) — the
   proven arrangement for exactly this product shape.
2. **Findings pinned to the waveform as colored spans; click a finding →
   seek, play, auto-pause at span end** (fixa, Observe.AI "key moments") —
   validates iteration 6; fixa's auto-pause and lifted hover state (waveform
   block + transcript chip highlight together) are the refinements to steal.
3. **Reciprocal sync**: playback highlights the active transcript line and
   auto-scrolls; clicking a line seeks audio (Label Studio paragraphs
   template, hyperaudio-lite mechanism).
4. **Stereo split-channel waveform** — agent and caller as separate bands, so
   interruptions and dead air are visible in the shape (fixa, Cekura stereo
   recordings, Coval channel-0/1 role assignment).
5. **Per-turn latency chips, decomposed by stage where known** (Hamming
   STT/LLM/TTS; Langfuse time-to-first-token marks) — matches the
   name-both-endpoints clock invariant.
6. **Sentiment/tool-calls as inline transcript annotations, not separate
   tabs** (Roark transcript overlay).
7. **Tree/timeline duality**: turn list vs time-proportional ribbon as two
   projections of the same frozen record with metric parity (Langfuse).
8. **Sibling-relative percentile heat coloring** for slow turns — no
   configured thresholds needed (Langfuse).

### Verdicts and evidence
9. **Per-criterion verdict + one-line explanation, judge reasoning one click
   deeper** (Coval Yes/No + Explanation; Vapi rubric + per-attempt LLM
   reasoning; Braintrust scorer chain-of-thought) — never a bare boolean.
10. **Every claim traces to a span** — the industry norm is verdict + cited
    moment; callbench's transcript-as-evidence invariant is the strong form.
11. **Judgment provenance recorded on every verdict: human / llm / code**
    (Phoenix annotator kinds) — aligns with "judgment recorded as judgment".
12. **An explicit abstain state** (Cekura "Review Required", Bluejay
    `allow_not_applicable`) — but nobody gives it a first-class color in the
    run table. Callbench's INCONCLUSIVE can own the amber/gray slot no
    competitor has claimed.
13. **Human adjudication as a first-class verb**: confirm / override /
    annotate the machine verdict inline (Coval Review, Level AI pre-filled
    scorecards with evidence, promptfoo cell override) — with agreement rates
    tracked between judge and human (Coval Metric Review).

### The run table and comparisons
14. **One column per assertion; per-metric failure counts as the headline**
    (Hamming) — "which assertion fails most" is the actionable number.
15. **Attempts/Trials grouping** to expose flakiness structurally (Vapi,
    Braintrust).
16. **Baseline-relative compare mode**: pick a source run; green = improved,
    red = regressed; header chips filter to regressions ("Order by
    regressions") (LangSmith, Braintrust).
17. **Saved views + "Unreviewed" as a triage state** — the table remembers
    what a human has looked at (Roark, Braintrust).
18. **Filter state serialized to the URL with typed operators** — a filtered
    view becomes a shareable, citable artifact (Roark, promptfoo). Pairs
    naturally with callbench's frozen-artifact citations.
19. **Aggregates in the chrome**: stats strip above, pass-rates in column
    headers, everything drills down to the underlying call (Coval, Roark).

### Run/artifact bookkeeping
20. **Runs snapshot what they tested** — config/versions recorded at execution
    so reports stay truthful after edits; staleness flags when definitions
    moved on (Roark, Coval resource versioning). Callbench's freeze-and-hash
    is the strong form; the UI idea is *showing* the snapshot identity.
21. **Monospace ids as visual identity** (`call_8a3f12`) and one large
    numeric score per call for scannability (Roark mock).
22. **Seed-deterministic static waveform** (ElevenLabs UI `StaticWaveform`) —
    render a stable thumbnail waveform from the frozen audio/hash for lists.
23. **Public/shareable report links, revocable, badge-marked** (Coval) — for
    callbench, the offline HTML report already fills this; the idea is the
    explicit "Public" marking.

### Authoring and evaluation mechanics (bench-side, some out of UI scope)
24. **Deterministic scripted tests with an action vocabulary** (Cekura
    Conditional Actions XML tags; Coval Script/DTMF/Skip input types) —
    reduces LLM-judge flakiness; rhymes with callbench's
    deterministic-at-runtime principle.
25. **Tool mocks with a tool-call-accuracy assertion** (Vapi, Cekura, Retell).
26. **Two-sided evidence merge** (Roark Enriched Simulations): caller-side
    recording merged with agent-side tool invocations — verify the agent "did
    the thing, not just said it". (Callbench can't see the target's insides —
    but the same idea applies to merging our dial-side capture with our own
    tool/timing logs.)
27. **Judge calibration surface**: replay judge prompts against ground-truth
    recordings until they match (Cekura Labs, Level AI sandbox) — for
    callbench, this is the calibration set the judge increment already has;
    the idea is making it a visible screen.
28. **Root-cause clustering of failures into themes** (Cekura Insights,
    Canonical Sad Path Analysis).
29. **Production-call → regression-test in one click** (Vapi thumbs-down,
    Hamming Scenario Rerun) — for callbench: "promote this call's moment to a
    pinned assertion".
30. **Coverage matrix views** (persona × scenario grid — Relyable Matrix
    Mode) — a compact way to show what's been exercised.
31. **Weighted rubric table with trend deltas per criterion** (Relyable:
    Criterion | Weight | Pass Rate | 7D Δ).
32. **IVR auto-discovery generating its own test suite** (Hammer Voice
    Explorer, 2001-era prior art; Roark scripted-DAG variants auto-derived per
    graph path) — discovery codified into deterministic tests is literally
    callbench's "agent discovers, code runs" principle.

### Things to explicitly NOT copy (fence items)
- **Unattended scale as the product** (50K concurrent calls, cron schedules,
  auto-redial, quality gates with automatic rollback): every one of these is a
  dial path callbench must not have. The gate is that the path does not exist.
- **Auto-optimization loops that mutate the system under test** (Cekura
  Optimize Agent, fixa prompt proposals): callbench does not own the target.
- **Real-time production monitoring**: callbench interprets frozen artifacts;
  nothing reaches back to the source.

---

## 6. What this means for callbench's look and feel

1. **The layout is settled convention**: run table (one column per assertion,
   stats in the chrome) → call detail (verdict rail + transcript +
   bottom-docked waveform with finding markers). Users arriving from any of
   these tools will already know how to read it. Iteration 6's
   click-a-finding-hear-its-moment is the industry's centerpiece pattern too —
   fixa's auto-pause-at-span-end and hover-linking are the two refinements
   worth adding.
2. **INCONCLUSIVE is a genuine visual differentiator**: no surveyed product
   renders a three-state verdict system. Give it a first-class color (amber)
   and a first-class column position — it expresses the honesty invariant
   nobody else has.
3. **Aesthetic register**: dual-theme, dense, monospace for ids/timings/
   hashes, green/red/amber chips, one large per-call score only if it's an
   honest number. The shadcn-adjacent look is the category's native dress and
   fits SvelteKit fine.
4. **Evidence-forward is on-trend and we hold the strong hand**: verdict +
   explanation + traceable span is the norm; frozen-hash citation and
   append-only history go further than anyone. Surface the artifact hash and
   snapshot identity in the UI rather than hiding them — it's the product's
   character.
5. **URL-serialized filter/view state** is cheap and compounds with the
   frozen-artifact model: any view of the evidence is a stable, shareable
   reference.
6. **Read fixa-observe's three files before building more of the call page**
   (`AudioPlayer.tsx`, `CallDetails.tsx`, `AudioVisualizationBlock.tsx`) —
   it is the one open codebase that solved this exact page, and it's frozen,
   readable, and permissively licensed.

---

## 7. Sources

Primary vendor pages and docs (fetched 2026-07-15): hamming.ai (+ /product,
/why-hamming, /pricing, /enterprise, /integrations/vapi, blog), cekura.ai
(+ /pricing, /changelog, docs.cekura.ai llms.txt + evaluators/metrics/guides
pages), coval.ai (+ /pricing, docs.coval.ai llms.txt + concepts pages,
changelog), roark.ai (+ /pricing, docs.roark.ai, changelog.roark.ai),
getbluejay.ai (+ docs.getbluejay.ai llms.txt, changelog, cookbook),
relyable.ai (+ /features), docs.vapi.ai (test/*, observability/*), vapi.ai/blog
(launching-testing-suites, evals), testmuai.com (voice-agent-testing,
agent-to-agent-testing, ivr-testing, regression blog, support docs),
nbulatest.ai (+ /pricing, /automated-testing), bug0.com (voice page, pricing),
voice.ai/ai-voice-agents/testing-and-monitoring/, voice.canonical.chat,
observe.ai (auto-qa, voice-ai-agents), thelevel.ai (QA, QA-GPT, virtual
agent), evaluagent.com/ai-agents, cyara.com (botium, agentic launch, testrtc),
hammer.com (ivr-testing, voice explorer), docs.retellai.com
(llm-simulation-testing), docs.livekit.io/agents/start/testing,
getmaxim.ai (voice simulation), braintrust.dev (voice articles, experiments
docs), langfuse.com (docs, changelogs), promptfoo.dev (web UI docs),
docs.datadoghq.com/llm_observability, channel.tel / chanl.ai.

GitHub (metadata + source reads): fixadev/fixa, fixadev/fixa-observe,
langfuse/langfuse, comet-ml/opik, Arize-ai/phoenix, promptfoo/promptfoo,
lmnr-ai/lmnr, HumanSignal/label-studio, katspaugh/wavesurfer.js,
hyperaudio/hyperaudio-lite, Meeting-BaaS/transcript-seeker,
pipecat-ai/voice-ui-kit, livekit-examples/agent-starter-react,
voicetestdev/voicetest, mlflow/mlflow, evidentlyai/evidently,
openai/openai-realtime-console, saharmor/voice-lab, bbc/react-transcript-editor.

Third-party: YC company/launch pages (Hamming, Cekura, Coval, Roark, Bluejay,
fixa), TechCrunch (Coval), PR Newswire (Coval Series A), BusinessWire (Hamming
seed), speechmatics.com 11-platforms roundup, webrtc.ventures Coval tutorial,
hamel.dev (eval-tool UX essays), ui.elevenlabs.io, Product Hunt pages, Show HN
threads (fixa 42783438, Hamming 41257369, Voicetest 47048811).

Competitor-authored comparisons (used with caution, flagged in text):
coval.ai/blog/hamming-vs-cekura, coval.ai/blog/cekura-vs-bluejay,
getbluejay.ai Bluejay-vs-Roark pricing page, cekura.ai testing-tools blog.
