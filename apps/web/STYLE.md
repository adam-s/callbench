# web style framework

The visual system for callbench's evidence viewer. **Built on shadcn-svelte +
Tailwind v4** (maintainer decision, July 2026, superseding the hand-rolled
token/primitive CSS this file previously described): components are vendored
into [src/lib/components/ui/](src/lib/components/ui/) and are ours to edit;
the theme lives in [src/app.css](src/app.css) as CSS variables feeding both
the shadcn contract and Tailwind utilities. Light mode only, by direction.
Register: a dense, light operations tool — chrome around content, white cards
on a tinted plane, hairline borders, tables over lists, monospace for evidence
identifiers.

## Color law (unchanged by the migration)

Color carries meaning in exactly **three places**; nothing else gets a status
color:

1. **The three-state outcome** — PASS, FAIL, INCONCLUSIVE. Three hues, never
   two-plus-a-shade. INCONCLUSIVE is a first-class outcome with its own
   purple-family hue: never a pale PASS, a muted FAIL, or a disabled gray —
   the render is where the third state gets quietly collapsed, so the render
   is where it is defended. Verdicts render ONLY via
   [OutcomePill](src/lib/components/OutcomePill.svelte) / the Badge verdict
   variants, which always carry the text label. Identity is never color alone.
2. **The two speakers** — `--bench` (blue) and `--target` (gold).
3. **The interactive accent** — `--primary` / `--accent` (blue), shared with
   the bench speaker on purpose ("us acting" and "us speaking" are one voice).

**The palette is computed, not tasteful.** Validated with the dataviz
six-checks validator (all-pairs, on white). Verdict trio: worst CVD ΔE 8.3,
clean pass. Speaker pair: ΔE 25.4. The full five-color set validates with
blue↔magenta in the CVD floor band, which is legal only with secondary
encoding — the always-present labels are that encoding. Two earlier pairs
failed this gate and were replaced — accent-blue vs indigo (normal-vision
ΔE 13 < 15) and orange-target vs red-FAIL (ΔE 11.2). **Do not change a hue in
app.css without re-running the validator**, and do not introduce a
purple/violet accent anywhere in the chrome: INCONCLUSIVE owns that hue
family.

`REFUSED` (an artifact that would not load) is FAIL's dashed outline, not a
fourth hue: it is not a verdict about the call, it is a refusal to render one.

## Where things live

- **Theme**: [src/app.css](src/app.css). One `:root` block defines the shadcn
  variable contract AND the legacy custom-property names (`--pass`, `--bench`,
  `--accent`, `--ink-2`, `--surface-2`, `--mono`, `--r-3`, …). The canvas
  components read the legacy names at render time via `getComputedStyle`, so
  the two vocabularies must stay in sync — one source, two spellings.
  `@theme inline` maps everything into Tailwind utilities (`text-pass`,
  `bg-inconclusive-bg`, `text-ink-3`, …).
- **Components**: vendored shadcn-svelte primitives (Card, Table, Badge,
  Button, Breadcrumb, Separator) under `ui/`; callbench-specific pieces
  (OutcomePill, CountsBar, Waveform, TurnRibbon, LevelMeter,
  PlaybackControls) beside them in `components/`.
- **Verdict variants** are vendored into
  [ui/badge/badge.svelte](src/lib/components/ui/badge/badge.svelte) —
  PASS / FAIL / INCONCLUSIVE / REFUSED. New verdict renders go through those,
  never ad-hoc classes.
- **Scoped styles** remain only for genuinely custom layout (the transcript's
  turn grid, the ribbon lanes) and use the legacy variable names.
- **E2E hooks**: the class names `pill`, `tile`, `chip`, `matrix`, `mixed`,
  `row-link`, `findings`, `turn`, `wave`, `ribbon`, `btn-icon`, `countsbar`,
  `rail-link`, `rail-foot`, `page-head`, `num muted` are load-bearing test
  selectors (see e2e/). Keep them on the elements when restyling.

## Type and density

13px base UI (set on `body` in app.css); tables and metadata go down, never
below 11px; page titles stop at 20px. Small and dense is the register —
whitespace does the separating, not size jumps. `font-mono` for evidence
identity: run ids, assertion names, timings, hashes, scenario slugs. Numeric
table columns are right-aligned `tabular-nums`.

## Canvas components

Waveform, level meter, and ribbon read their colors from the CSS custom
properties at render time (`getComputedStyle`), so they follow the theme
without duplicating hexes. Fallback hexes in those files mirror app.css and
change together with it.

**The canvas is a static picture; motion is an overlay.** The waveform repaints
only when its data or size changes; the playhead and hover readout are
composited elements whose position updates per frame (pattern from the
maintainer's `~/Projects/separate` audio essay). Measured on adoption: playback
script cost fell 62→33 ms per second of playback at a steady 120fps, zero long
frames (`pnpm perf`, `.perf/*/results.json`). Never draw a per-frame stroke
into a canvas that otherwise never changes. The one exception is the level
meter, whose content IS per-frame.

## Mobile (field parity, not field loss)

The reference pattern: a dense desktop table maps **one-to-one** onto stacked
label-value rows on a phone — every field present, restacked, nothing parked
behind horizontal scroll. Each data table ships both renderings (`hidden
sm:block` table + `sm:hidden` stacked list) with identical fields. The
transcript's turn collapses to two lines (speaker + text, timing on its own
row) below 560px. The exception is the assertion matrix, which scrolls inside
its own container — a matrix is the one shape that genuinely is 2-D.

## What this framework refuses

- **No dial affordances.** No control anywhere may look like "run this test" —
  the play vocabulary (▶) is reserved for playback of frozen recordings, and
  every playback surface carries its fence note. Pinned by the e2e fence spec.
- **No collapsed third state.** Any new view that renders outcomes renders
  three, with INCONCLUSIVE's own hue and label.
- **No figures from the browser.** The meter, playhead, and waveform render a
  file's properties; none of it may be presented as a measurement of the call.
