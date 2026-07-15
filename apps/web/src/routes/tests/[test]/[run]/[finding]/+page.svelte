<script lang="ts">
	import { shortRun, whereOf } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// The turn the finding cites — the one the reader should land on. INCONCLUSIVE
	// cites no span, so there is nothing to highlight, which is itself the point:
	// the finding could not be evaluated because the flow never reached it.
	const citedTurn = $derived(data.finding.span?.turnIndex ?? null);
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
{:else}
	<p class="sub" style="margin-top:1.25rem">
		The cited moment is highlighted below. Playing it back arrives with the audio engine (next
		increment); the span and its place in the call are the evidence today.
	</p>
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
		margin-bottom: 0.5rem;
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
