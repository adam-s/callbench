<script lang="ts">
	import { Transport } from '$lib/audio/transport.svelte.ts';
	import LevelMeter from '$lib/components/LevelMeter.svelte';
	import PlaybackControls from '$lib/components/PlaybackControls.svelte';
	import TurnRibbon from '$lib/components/TurnRibbon.svelte';
	import Waveform, { type WaveSpan } from '$lib/components/Waveform.svelte';
	import { shortRun, whereOf } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// One flat, ordered list of findings — code results then judge verdicts —
	// each addressable by its assertion name for the deep link. INCONCLUSIVE is
	// kept distinct; nothing here collapses it.
	const findings = $derived([
		...data.results.map((r) => ({
			kind: 'code' as const,
			assertion: r.assertion,
			outcome: r.outcome,
			detail: r.detail,
			span: r.span,
			by: null as string | null,
		})),
		...data.verdicts.map((v) => ({
			kind: 'judge' as const,
			assertion: v.assertion,
			outcome: v.outcome,
			detail: v.reasoning,
			span: v.span,
			by: v.judgedBy,
		})),
	]);

	// The audio replay engine. Only wired for a replayable (simulator) run that
	// actually has audio; a system-under-test run never reaches this branch.
	const hasAudio = $derived(data.replayable && data.audio !== null);
	const transport = new Transport();

	// Load whenever the run's audio changes (SvelteKit reuses this component across
	// [run] navigations). load() reuses the element/graph — no teardown here.
	$effect(() => {
		if (data.audio) transport.load(data.audio.url, data.audio.durationMs / 1000);
	});

	// Destroy ONLY on unmount. This effect reads nothing reactive, so it runs once
	// and its cleanup fires only when the component is torn down — not on every
	// navigation, which would close the AudioContext mid-session.
	$effect(() => () => transport.destroy());

	// Finding spans on the waveform — the shape of the call and the claims about it
	// as one picture.
	const waveSpans = $derived<WaveSpan[]>(
		findings
			.filter((f) => f.span !== null)
			.map((f) => ({
				startMs: f.span!.startMs,
				endMs: f.span!.endMs,
				outcome: f.outcome,
				assertion: f.assertion,
			})),
	);

	// The turn under the playhead right now — highlighted so the transcript scrolls
	// in lockstep with playback. Reads the one clock (transport.t), in ms.
	const playingTurn = $derived.by(() => {
		const ms = transport.t * 1000;
		return data.turns.findIndex((t) => ms >= t.startMs && ms < t.endMs);
	});

	function hear(span: { startMs: number; endMs: number }) {
		transport.playRegion(span.startMs / 1000, span.endMs / 1000);
	}
</script>

<div class="crumbs">
	<a href="/">callbench</a> / <a href="/tests/{data.scenario}">{data.scenario}</a> / {shortRun(
		data.runId,
	)}
</div>
<h1 class="mono">{shortRun(data.runId)}</h1>
<p class="sub">
	{data.scenario} · target <span class="mono">{data.target}</span> · PASS {data.counts.PASS} · FAIL
	{data.counts.FAIL} · INCONCLUSIVE {data.counts.INCONCLUSIVE}
</p>

{#if hasAudio && data.audio}
	<Waveform {transport} peaks={data.audio.peaks} durationMs={data.audio.durationMs} spans={waveSpans} />
	<div class="player">
		<div class="player-controls"><PlaybackControls {transport} /></div>
		<div class="player-meter"><LevelMeter {transport} /></div>
	</div>
	<h2>Turn ribbon</h2>
	<p class="sub">
		Two lanes on a real time axis — the rhythm of the call at a glance. Click a block to seek there;
		the block under the playhead lights up. Where the two lanes overlap is literal talkover.
	</p>
	<TurnRibbon turns={data.turns} durationMs={data.audio.durationMs} {transport} />
	{#if data.audio.synthetic}
		<p class="fence-note">
			Simulator run — the audio is synthesized from the turn text ({data.audio.synthetic}), a stand-in
			for a real call recording. Click any finding's ▶ to hear its moment. Nobody's line rings.
		</p>
	{/if}
{:else if data.replayable}
	<p class="fence-note">Simulator run — replayable, but this run has no audio recording.</p>
{:else}
	<p class="fence-note">
		System-under-test run — view only. No replay or re-run control exists for a stranger's line;
		that path is not built, by design.
	</p>
{/if}

<h2>Findings</h2>
<ul class="findings">
	{#each findings as f (f.kind + f.assertion)}
		<li>
			<div class="frow">
				{#if hasAudio && f.span}
					<button class="hear" title="Hear this span" aria-label="Hear this span" onclick={() => hear(f.span!)}>▶</button>
				{/if}
				<a class="flink" href="/tests/{data.scenario}/{data.runId}/{f.assertion}">
					<span class="pill {f.outcome}">{f.outcome}</span>
					<span class="fname mono">{f.assertion}</span>
					<span class="fwhere muted mono">{whereOf(f)}</span>
				</a>
			</div>
			<p class="fdetail">
				{f.detail}
				{#if f.by}<span class="muted"> — judged by {f.by}</span>{/if}
			</p>
		</li>
	{/each}
</ul>

<h2>Transcript</h2>
<p class="sub">Verbatim, with session-clock timings. Every finding above traces to a span here.</p>
<ol class="transcript">
	{#each data.turns as turn, i (i)}
		<li class="turn {turn.speaker}" class:playing={i === playingTurn}>
			<span class="who">{turn.speaker === 'bench' ? 'BENCH' : 'AGENT'}</span>
			<span class="text">{turn.text}</span>
			<span class="time muted mono">
				{turn.startMs}–{turn.endMs}ms
				{#if turn.confidence}· conf {turn.confidence.score.toFixed(2)}{/if}
			</span>
		</li>
	{/each}
</ol>

<style>
	.player {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 0.6rem 0 0.25rem;
	}
	.player-controls {
		flex: 1;
		min-width: 0;
	}
	.player-meter {
		flex: none;
		width: 180px;
	}
	@media (max-width: 560px) {
		.player {
			flex-direction: column;
			align-items: stretch;
		}
		.player-meter {
			width: 100%;
		}
	}
	.findings {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
	}
	.findings li {
		padding: 0.55rem 0;
		border-top: 1px solid var(--border);
	}
	.frow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.hear {
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--accent);
		cursor: pointer;
		font-size: 0.6rem;
		line-height: 1;
	}
	.hear:hover {
		background: var(--surface-2);
	}
	.flink {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: inherit;
	}
	.flink:hover {
		text-decoration: none;
	}
	.flink:hover .fname {
		text-decoration: underline;
	}
	.fname {
		font-weight: 600;
	}
	.fwhere {
		font-size: 0.78rem;
	}
	.fdetail {
		margin: 0.3rem 0 0 2.1rem;
		color: var(--ink-2);
		font-size: 0.9rem;
	}
	.transcript {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.turn {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		transition: background 0.1s;
	}
	.turn.bench {
		background: color-mix(in srgb, var(--bench) 8%, transparent);
	}
	.turn.target {
		background: color-mix(in srgb, var(--target) 8%, transparent);
	}
	.turn.playing {
		outline: 2px solid var(--accent);
	}
	.who {
		font-family: var(--mono);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.03em;
	}
	.turn.bench .who {
		color: var(--bench);
	}
	.turn.target .who {
		color: var(--target);
	}
	.time {
		font-size: 0.72rem;
		white-space: nowrap;
	}
</style>
