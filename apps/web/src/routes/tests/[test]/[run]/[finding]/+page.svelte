<script lang="ts">
	import { Transport } from '$lib/audio/transport.svelte.ts';
	import OutcomePill from '$lib/components/OutcomePill.svelte';
	import PlaybackControls from '$lib/components/PlaybackControls.svelte';
	import Waveform, { type WaveSpan } from '$lib/components/Waveform.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { shortRun, whereOf } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// The turn the finding cites — the one the reader should land on. INCONCLUSIVE
	// cites no span, so there is nothing to highlight, which is itself the point.
	const citedTurn = $derived(data.finding.span?.turnIndex ?? null);
	const cited = $derived(
		data.finding.span
			? { startMs: data.finding.span.startMs, endMs: data.finding.span.endMs }
			: null,
	);

	const hasAudio = $derived(data.audio !== null);
	const transport = new Transport();

	// A stable identity for THIS finding — so navigating to another finding in the
	// same session re-fires the auto-play instead of being suppressed by a guard
	// that never resets.
	const findingKey = $derived(`${data.runId}/${data.finding.assertion}`);

	// Load whenever the run's audio changes. load() reuses the element/graph.
	$effect(() => {
		if (data.audio) transport.load(data.audio.url, data.audio.durationMs / 1000);
	});

	// THE CENTERPIECE, completed: land on a finding and hear its moment. Play the
	// cited span once per finding (keyed on findingKey, so a second finding also
	// auto-plays). Autoplay may be blocked by the browser until a gesture; the
	// waveform, playhead, and controls are present regardless, so a blocked
	// autoplay degrades to "press play", not a dead page (the engine's wall-clock
	// fallback keeps the playhead honest).
	let autoplayedKey: string | null = null;
	$effect(() => {
		if (data.audio && cited && autoplayedKey !== findingKey) {
			autoplayedKey = findingKey;
			transport.playRegion(cited.startMs / 1000, cited.endMs / 1000);
		}
	});

	// Destroy ONLY on unmount (no reactive reads → cleanup fires once, on teardown).
	$effect(() => () => transport.destroy());

	const waveSpans = $derived<WaveSpan[]>(
		cited
			? [
					{
						startMs: cited.startMs,
						endMs: cited.endMs,
						outcome: data.finding.outcome,
						assertion: data.finding.assertion,
					},
				]
			: [],
	);
</script>

<svelte:head>
	<title>{data.finding.assertion} · {shortRun(data.runId)} · callbench</title>
	<meta
		name="description"
		content="Finding {data.finding.assertion} ({data.finding.outcome}) in run {shortRun(data.runId)} of {data.scenario} — lands on the cited transcript span."
	/>
</svelte:head>

<div class="page-head flex flex-wrap items-center gap-3">
	<h1 class="font-mono text-xl font-semibold tracking-tight">{data.finding.assertion}</h1>
	<OutcomePill state={data.finding.outcome} />
	<Badge variant="outline" class="chip">{data.finding.kind}</Badge>
	<span class="text-ink-3 font-mono text-xs">{whereOf(data.finding)}</span>
</div>

<Card.Root class="py-0">
	<Card.Content class="p-4">
		{data.finding.detail}
		{#if data.finding.by}<span class="text-ink-3"> — judged by {data.finding.by}</span>{/if}
	</Card.Content>
</Card.Root>

{#if citedTurn === null}
	<p class="fence-note text-ink-3 border-l-2 pl-2 text-xs">
		This finding cites no span — it could not be evaluated (the flow never reached the point it
		would judge), so there is no moment to land on. That absence is the finding.
	</p>
{:else if hasAudio && data.audio}
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b px-4 !py-3">
			<Card.Title class="text-base">The moment</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3 p-4">
			<Waveform
				{transport}
				peaks={data.audio.peaks}
				durationMs={data.audio.durationMs}
				spans={waveSpans}
				{cited}
			/>
			<div class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
				<div class="min-w-0 flex-1"><PlaybackControls {transport} /></div>
				<Button
					variant="outline"
					size="sm"
					class="flex-none"
					onclick={() => cited && transport.playRegion(cited.startMs / 1000, cited.endMs / 1000)}
				>
					▶ Hear this moment
				</Button>
			</div>
		</Card.Content>
		{#if data.audio.synthetic}
			<div class="text-ink-3 border-t px-4 py-2 text-xs">
				Audio synthesized from the turn text ({data.audio.synthetic}); a stand-in until a live
				recording.
			</div>
		{/if}
	</Card.Root>
{:else}
	<p class="fence-note text-ink-3 border-l-2 pl-2 text-xs">
		No audio for this run — the cited moment is highlighted below.
	</p>
{/if}

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b px-4 !py-3">
		<Card.Title class="text-base">Transcript</Card.Title>
	</Card.Header>
	<ol class="transcript px-3 py-2">
		{#each data.turns as turn, i (i)}
			<li class="turn {turn.speaker}" class:cited={i === citedTurn}>
				<span class="who">{turn.speaker === 'bench' ? 'BENCH' : 'AGENT'}</span>
				<span class="text">{turn.text}</span>
				<span class="time text-ink-3 font-mono">{turn.startMs}–{turn.endMs}ms</span>
			</li>
		{/each}
	</ol>
</Card.Root>

<style>
	/* The turn grid itself is the shared .transcript block in app.css; this
	 * page's treatment — dim everything but the cited moment — lives here. */
	.turn {
		opacity: 0.55;
		transition: opacity var(--t-fast);
	}
	.turn.cited {
		opacity: 1;
		outline: 2px solid var(--accent);
	}
</style>
