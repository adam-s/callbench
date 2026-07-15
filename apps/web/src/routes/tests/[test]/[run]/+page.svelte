<script lang="ts">
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

{#if data.replayable}
	<p class="fence-note">
		Simulator run — replayable. Audio playback and the click-a-finding-to-hear-it gesture arrive
		with the audio engine (next increment). Nobody's line rings.
	</p>
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
			<a class="frow" href="/tests/{data.scenario}/{data.runId}/{f.assertion}">
				<span class="pill {f.outcome}">{f.outcome}</span>
				<span class="fname mono">{f.assertion}</span>
				<span class="fwhere muted mono">{whereOf(f)}</span>
			</a>
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
		<li class="turn {turn.speaker}">
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
		color: inherit;
	}
	.frow:hover {
		text-decoration: none;
	}
	.frow:hover .fname {
		text-decoration: underline;
	}
	.fname {
		font-weight: 600;
	}
	.fwhere {
		font-size: 0.78rem;
	}
	.fdetail {
		margin: 0.3rem 0 0;
		color: var(--ink-2);
		font-size: 0.9rem;
	}
	.transcript {
		list-style: none;
		margin: 0;
		padding: 0;
		counter-reset: turn;
	}
	.turn {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
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
