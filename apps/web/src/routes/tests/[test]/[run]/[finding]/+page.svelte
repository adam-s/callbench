<script lang="ts">
	import { Transport } from '$lib/audio/transport.svelte.ts';
	import PlaybackControls from '$lib/components/PlaybackControls.svelte';
	import Waveform, { type WaveSpan } from '$lib/components/Waveform.svelte';
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

<div class="crumbs">
	<a href="/">callbench</a> / <a href="/tests/{data.scenario}">{data.scenario}</a> /
	<a href="/tests/{data.scenario}/{data.runId}">{shortRun(data.runId)}</a> / {data.finding.assertion}
</div>

<h1 class="mono">{data.finding.assertion}</h1>
<p class="sub">
	<span class="pill {data.finding.outcome}">{data.finding.outcome}</span>
	<span class="muted mono">{whereOf(data.finding)}</span>
	{#if data.finding.by}<span class="muted"> · judged by {data.finding.by}</span>{/if}
</p>

<div class="card detail">{data.finding.detail}</div>

{#if citedTurn === null}
	<p class="fence-note">
		This finding cites no span — it could not be evaluated (the flow never reached the point it
		would judge), so there is no moment to land on. That absence is the finding.
	</p>
{:else if hasAudio && data.audio}
	<div class="hearbar">
		<Waveform {transport} peaks={data.audio.peaks} durationMs={data.audio.durationMs} spans={waveSpans} {cited} />
		<div class="player">
			<PlaybackControls {transport} />
			<button class="again" onclick={() => cited && transport.playRegion(cited.startMs / 1000, cited.endMs / 1000)}>
				▶ Hear this moment
			</button>
		</div>
		{#if data.audio.synthetic}
			<p class="fence-note">Audio synthesized from the turn text ({data.audio.synthetic}); a stand-in until a live recording.</p>
		{/if}
	</div>
{:else}
	<p class="sub" style="margin-top:1.25rem">The cited moment is highlighted below.</p>
{/if}

<ol class="transcript">
	{#each data.turns as turn, i (i)}
		<li class="turn {turn.speaker}" class:cited={i === citedTurn}>
			<span class="who">{turn.speaker === 'bench' ? 'BENCH' : 'AGENT'}</span>
			<span class="text">{turn.text}</span>
			<span class="time muted mono">{turn.startMs}–{turn.endMs}ms</span>
		</li>
	{/each}
</ol>

<style>
	.detail {
		margin-bottom: 0.75rem;
	}
	.hearbar {
		margin-bottom: 1.25rem;
	}
	.player {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-top: 0.6rem;
	}
	.again {
		flex: none;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--accent);
		border-radius: var(--radius);
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.again:hover {
		background: var(--surface-2);
	}
	.transcript {
		list-style: none;
		margin: 1rem 0 0;
		padding: 0;
	}
	.turn {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		opacity: 0.55;
		transition: opacity 0.15s;
	}
	.turn.cited {
		opacity: 1;
		outline: 2px solid var(--accent);
	}
	.turn.bench {
		background: color-mix(in srgb, var(--bench) 8%, transparent);
	}
	.turn.target {
		background: color-mix(in srgb, var(--target) 8%, transparent);
	}
	.who {
		font-family: var(--mono);
		font-size: 0.7rem;
		font-weight: 700;
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
