<script lang="ts">
	import { shortRun, worstOutcome, type Outcome } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// The assertion matrix: assertions × runs, each cell a three-state outcome.
	// Rows are the union of every assertion name seen across runs (code + judged),
	// in first-seen order so the layout is stable run to run.
	const assertionNames = $derived.by(() => {
		const seen: string[] = [];
		for (const run of data.runs) {
			for (const r of run.results) if (!seen.includes(r.assertion)) seen.push(r.assertion);
			for (const v of run.verdicts) if (!seen.includes(v.assertion)) seen.push(v.assertion);
		}
		return seen;
	});

	function outcomeFor(run: PageData['runs'][number], assertion: string): Outcome | null {
		const r = run.results.find((x) => x.assertion === assertion);
		if (r) return r.outcome;
		const v = run.verdicts.find((x) => x.assertion === assertion);
		return v ? v.outcome : null;
	}

	// A row is "mixed" when the same assertion lands on different outcomes across
	// runs — flakiness in the system under test, which ui.md calls the finding.
	function rowMixed(assertion: string): boolean {
		const outcomes = new Set(data.runs.map((r) => outcomeFor(r, assertion)).filter(Boolean));
		return outcomes.size > 1;
	}
</script>

<div class="crumbs"><a href="/">callbench</a> / {data.scenario}</div>
<h1 class="mono">{data.scenario}</h1>
<p class="sub">{data.runs.length} run{data.runs.length === 1 ? '' : 's'}. Each column is one run;
	each row is one assertion. A row that changes color across runs is the finding.</p>

<h2>Assertion matrix</h2>
<div class="matrix-scroll">
	<table class="matrix">
		<thead>
			<tr>
				<th class="corner">assertion</th>
				{#each data.runs as run (run.runId)}
					<th>
						<a href="/tests/{data.scenario}/{run.runId}" class="mono">{shortRun(run.runId)}</a>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each assertionNames as name (name)}
				<tr class:mixed={rowMixed(name)}>
					<th class="rowname mono" scope="row">
						{name}
						{#if rowMixed(name)}<span class="mixed-tag" title="outcome varies across runs">mixed</span>{/if}
					</th>
					{#each data.runs as run (run.runId)}
						{@const o = outcomeFor(run, name)}
						<td>
							{#if o}<span class="pill {o}">{o}</span>{:else}<span class="muted">—</span>{/if}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<h2>Runs</h2>
<ul class="runs">
	{#each data.runs as run (run.runId)}
		{@const o = worstOutcome(run.counts)}
		<li>
			<a class="mono" href="/tests/{data.scenario}/{run.runId}">{shortRun(run.runId)}</a>
			<span class="pill {o}">{o}</span>
			<span class="muted mono">
				PASS {run.counts.PASS} · FAIL {run.counts.FAIL} · INCONCLUSIVE {run.counts.INCONCLUSIVE}
			</span>
			<span class="muted">{run.target}</span>
		</li>
	{/each}
</ul>

{#if data.broken.length > 0}
	<h2>Refused runs</h2>
	<p class="sub">
		These runs exist on disk but would not load — the artifact drifted from what was frozen, or is
		mislabeled or corrupt. They are shown, not hidden: a refused run is an intervention to see, not
		a row to delete.
	</p>
	<ul class="runs">
		{#each data.broken as b (b.runId)}
			<li>
				<span class="mono">{shortRun(b.runId)}</span>
				<span class="pill FAIL">REFUSED</span>
				<span class="muted">{b.error}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.matrix-scroll {
		overflow-x: auto;
	}
	.matrix {
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.matrix th,
	.matrix td {
		border: 1px solid var(--border);
		padding: 0.4rem 0.6rem;
		text-align: center;
	}
	.matrix .corner,
	.matrix .rowname {
		text-align: left;
		background: var(--surface-2);
		white-space: nowrap;
	}
	.matrix tr.mixed .rowname {
		box-shadow: inset 3px 0 0 var(--inconclusive);
	}
	.mixed-tag {
		font-size: 0.65rem;
		color: var(--inconclusive);
		margin-left: 0.4rem;
	}
	.runs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.runs li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.45rem 0;
		border-top: 1px solid var(--border);
	}
</style>
