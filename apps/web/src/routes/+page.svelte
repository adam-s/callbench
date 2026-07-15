<script lang="ts">
	import { worstOutcome } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	function pct(x: number): string {
		return `${Math.round(x * 100)}%`;
	}
</script>

<h1>callbench</h1>
<p class="sub">
	A test bench for voice agents reached over the phone. Tests are authored in code; this renders
	what running them produced.
</p>

{#if data.scenarios.length === 0}
	<div class="card muted">No runs on disk yet. Generate the fixtures, or record a run.</div>
{:else}
	<h2>Scenarios</h2>
	<ul class="list">
		{#each data.scenarios as s (s.scenario)}
			<li class="row">
				<a class="name" href="/tests/{s.scenario}">{s.scenario}</a>
				<span class="meta">
					{#if s.latest}
						{@const o = worstOutcome(s.latest.counts)}
						<span class="pill {o}">{o}</span>
					{/if}
					<span class="muted mono">{s.runCount} run{s.runCount === 1 ? '' : 's'}</span>
					<span class="muted mono">{pct(s.cleanRate)} clean</span>
					{#if s.brokenCount > 0}
						<span class="pill FAIL" title="runs that would not load">{s.brokenCount} refused</span>
					{/if}
				</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.7rem 1rem;
		background: var(--surface);
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.name {
		font-weight: 600;
		font-family: var(--mono);
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.85rem;
	}
</style>
