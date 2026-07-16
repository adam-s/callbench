<script lang="ts">
	import { Transport } from '$lib/audio/transport.svelte.ts';
	import CountsBar from '$lib/components/CountsBar.svelte';
	import LevelMeter from '$lib/components/LevelMeter.svelte';
	import OutcomePill from '$lib/components/OutcomePill.svelte';
	import PlaybackControls from '$lib/components/PlaybackControls.svelte';
	import TurnRibbon from '$lib/components/TurnRibbon.svelte';
	import Waveform, { type WaveSpan } from '$lib/components/Waveform.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { shortRun, whereOf, worstOutcome } from '$lib/types.ts';
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

	// Audio playback is EVIDENCE — offered for any run with a recording, simulator
	// or real call. It plays a frozen file; it is not a dial. (The dial fence gates
	// a re-run control, which the UI does not have.)
	const hasAudio = $derived(data.audio !== null);
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

	// The turn under the playhead right now — highlighted and kept in view so the
	// transcript scrolls in lockstep with playback. Reads the one clock.
	const playingTurn = $derived.by(() => {
		const ms = transport.t * 1000;
		return data.turns.findIndex((t) => ms >= t.startMs && ms < t.endMs);
	});

	// The reciprocal half of click-a-finding-hear-it: while audio plays, the
	// transcript pane follows. Scrolls its own pane only (block:'nearest' inside
	// the scroll container), so the page itself never jumps.
	let transcriptPane: HTMLElement | undefined = $state();
	$effect(() => {
		if (playingTurn < 0 || !transport.playing || !transcriptPane) return;
		const el = transcriptPane.querySelector(`[data-turn="${playingTurn}"]`);
		el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	function hear(span: { startMs: number; endMs: number }) {
		transport.playRegion(span.startMs / 1000, span.endMs / 1000);
	}

	const worst = $derived(worstOutcome(data.counts));
</script>

<svelte:head>
	<title>{shortRun(data.runId)} · {data.scenario} · callbench</title>
	<meta
		name="description"
		content="Run {shortRun(data.runId)} of {data.scenario}: transcript, findings, and call audio — PASS {data.counts.PASS}, FAIL {data.counts.FAIL}, INCONCLUSIVE {data.counts.INCONCLUSIVE}."
	/>
</svelte:head>

<div class="page-head flex flex-wrap items-center gap-3">
	<h1 class="font-mono text-xl font-semibold tracking-tight">{shortRun(data.runId)}</h1>
	<OutcomePill state={worst} />
	<CountsBar counts={data.counts} />
	<Badge variant="outline" class="chip">{data.target}</Badge>
	<span class="text-ink-3 font-mono text-xs tabular-nums">
		PASS {data.counts.PASS} · FAIL {data.counts.FAIL} · INCONCLUSIVE {data.counts.INCONCLUSIVE}
	</span>
</div>

{#if hasAudio && data.audio}
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b px-4 !py-3">
			<Card.Title class="text-base">The call</Card.Title>
			<Card.Description class="text-xs">
				click the waveform to seek · click a turn block to jump · overlap is talkover
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3 p-4">
			<Waveform {transport} peaks={data.audio.peaks} durationMs={data.audio.durationMs} spans={waveSpans} />
			<TurnRibbon turns={data.turns} durationMs={data.audio.durationMs} {transport} />
			<div class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
				<div class="min-w-0 flex-1"><PlaybackControls {transport} /></div>
				<div class="w-full sm:w-44 sm:flex-none"><LevelMeter {transport} /></div>
			</div>
		</Card.Content>
		<div class="text-ink-3 border-t px-4 py-2 text-xs">
			{#if data.audio.synthetic}
				Simulator run — audio synthesized from the turn text ({data.audio.synthetic}), a stand-in
				for a real recording. Click any finding's ▶ to hear its moment. Nobody's line rings.
			{:else}
				Recorded call — playback of a frozen recording. Click any finding's ▶ to hear its moment.
				There is no re-run or re-dial control for a real line.
			{/if}
		</div>
	</Card.Root>
{:else if data.replayable}
	<p class="fence-note text-ink-3 border-l-2 pl-2 text-xs">
		Simulator run — replayable, but this run has no audio recording.
	</p>
{:else}
	<p class="fence-note text-ink-3 border-l-2 pl-2 text-xs">This run has no audio recording.</p>
{/if}

<div class="grid items-start gap-4 lg:grid-cols-2">
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b px-4 !py-3">
			<Card.Title class="text-base">Findings</Card.Title>
		</Card.Header>
		<ul class="findings divide-y px-4 py-2">
			{#each findings as f (f.kind + f.assertion)}
				<li class="py-2">
					<div class="flex items-center gap-2">
						{#if hasAudio && f.span}
							<button
								class="btn-icon text-primary border-input bg-card hover:bg-muted inline-flex size-[22px] flex-none cursor-pointer items-center justify-center rounded-full border text-[0.55rem]"
								title="Hear this span"
								aria-label="Hear this span"
								onclick={() => hear(f.span!)}>▶</button>
						{:else}
							<span class="w-[22px] flex-none"></span>
						{/if}
						<a
							class="group flex min-w-0 items-center gap-2 text-inherit"
							href="/tests/{data.scenario}/{data.runId}/{f.assertion}"
						>
							<OutcomePill state={f.outcome} />
							<span class="font-mono font-semibold group-hover:underline">{f.assertion}</span>
						</a>
						<Badge variant="outline" class="chip">{f.kind}</Badge>
					</div>
					<p class="text-muted-foreground mt-1 ml-[30px]">
						{f.detail}
						{#if f.by}<span class="text-ink-3"> — judged by {f.by}</span>{/if}
					</p>
					<p class="text-ink-3 mt-0.5 ml-[30px] font-mono text-xs">{whereOf(f)}</p>
				</li>
			{/each}
		</ul>
	</Card.Root>

	<Card.Root class="gap-0 py-0 lg:sticky lg:top-4">
		<Card.Header class="border-b px-4 !py-3">
			<Card.Title class="text-base">Transcript</Card.Title>
			<Card.Description class="text-xs">
				verbatim, session clock — every finding traces to a span here
			</Card.Description>
		</Card.Header>
		<ol class="transcript max-h-[72vh] overflow-y-auto px-3 py-2" bind:this={transcriptPane}>
			{#each data.turns as turn, i (i)}
				<li class="turn {turn.speaker}" class:playing={i === playingTurn} data-turn={i}>
					<span class="who">{turn.speaker === 'bench' ? 'BENCH' : 'AGENT'}</span>
					<span class="text">{turn.text}</span>
					<span class="time text-ink-3 font-mono">
						{turn.startMs}–{turn.endMs}ms
						{#if turn.confidence}· conf {turn.confidence.score.toFixed(2)}{/if}
					</span>
				</li>
			{/each}
		</ol>
	</Card.Root>
</div>

<style>
	/* The turn grid itself is the shared .transcript block in app.css; only
	 * this page's divergences live here. */
	.turn.playing {
		outline: 2px solid var(--accent);
	}
	.who {
		letter-spacing: 0.03em;
	}
</style>
