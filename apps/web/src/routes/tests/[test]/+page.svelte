<script lang="ts">
	import CountsBar from '$lib/components/CountsBar.svelte';
	import OutcomePill from '$lib/components/OutcomePill.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { ago } from '$lib/format.ts';
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

<svelte:head>
	<title>{data.scenario} · callbench</title>
	<meta
		name="description"
		content="Scenario {data.scenario}: assertion matrix and every run of it — {data.runs.length} run{data.runs.length === 1 ? '' : 's'}."
	/>
</svelte:head>

<div class="page-head flex flex-wrap items-center gap-3">
	<h1 class="font-mono text-xl font-semibold tracking-tight">{data.scenario}</h1>
	<Badge variant="outline" class="chip">{data.runs.length} run{data.runs.length === 1 ? '' : 's'}</Badge>
	{#if data.broken.length > 0}
		<OutcomePill state="REFUSED" />
	{/if}
</div>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b px-4 !py-3">
		<Card.Title class="text-base">Assertion matrix</Card.Title>
		<Card.Description class="text-xs">
			one column per run — a row that changes outcome across runs is the finding
		</Card.Description>
	</Card.Header>
	<Card.Content class="overflow-x-auto p-0">
		<table class="matrix w-full border-collapse text-[0.8125rem]">
			<thead>
				<tr class="bg-muted">
					<th
						class="text-ink-3 sticky left-0 z-10 bg-muted px-3 py-2 text-left text-[0.6875rem] font-semibold tracking-wider uppercase"
					>
						Assertion
					</th>
					{#each data.runs as run (run.runId)}
						<th class="px-3 py-2 text-center">
							<a href="/tests/{data.scenario}/{run.runId}" class="text-primary font-mono text-xs hover:underline">
								{shortRun(run.runId)}
							</a>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each assertionNames as name (name)}
					{@const mixed = rowMixed(name)}
					<tr class="border-b last:border-b-0 {mixed ? 'mixed' : ''}">
						<th
							scope="row"
							class="bg-card sticky left-0 z-10 px-3 py-2 text-left font-mono text-xs font-medium whitespace-nowrap {mixed
								? 'shadow-[inset_3px_0_0_var(--inconclusive)]'
								: ''}"
						>
							{name}
							{#if mixed}
								<span class="mixed-tag text-inconclusive ml-2 font-mono text-[0.6875rem]" title="outcome varies across runs">
									MIXED
								</span>
							{/if}
						</th>
						{#each data.runs as run (run.runId)}
							{@const o = outcomeFor(run, name)}
							<td class="px-3 py-2 text-center">
								{#if o}
									<a href="/tests/{data.scenario}/{run.runId}/{name}"><OutcomePill state={o} /></a>
								{:else}
									<span class="text-ink-3">—</span>
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</Card.Content>
</Card.Root>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b px-4 !py-3">
		<Card.Title class="text-base">Runs</Card.Title>
	</Card.Header>

	<!-- Desktop/tablet: the dense table. -->
	<Card.Content class="hidden p-0 sm:block">
		<Table.Root class="table">
			<Table.Header>
				<Table.Row class="bg-muted hover:bg-muted">
					<Table.Head>Run</Table.Head>
					<Table.Head>Worst</Table.Head>
					<Table.Head>Outcomes</Table.Head>
					<Table.Head>Target</Table.Head>
					<Table.Head class="text-right">When</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.runs as run (run.runId)}
					{@const o = worstOutcome(run.counts)}
					<Table.Row>
						<Table.Cell>
							<a class="row-link font-mono font-semibold hover:underline" href="/tests/{data.scenario}/{run.runId}">
								{shortRun(run.runId)}
							</a>
						</Table.Cell>
						<Table.Cell><OutcomePill state={o} /></Table.Cell>
						<Table.Cell>
							<CountsBar counts={run.counts} />
							<span class="text-ink-3 ml-2 font-mono text-xs tabular-nums">
								{run.counts.PASS}·{run.counts.FAIL}·{run.counts.INCONCLUSIVE}
							</span>
						</Table.Cell>
						<Table.Cell><Badge variant="outline" class="chip">{run.target}</Badge></Table.Cell>
						<Table.Cell class="text-ink-3 num muted text-right tabular-nums">{ago(run.createdEpochMs)}</Table.Cell>
					</Table.Row>
				{/each}
				{#each data.broken as b (b.runId)}
					<Table.Row>
						<Table.Cell><span class="font-mono">{shortRun(b.runId)}</span></Table.Cell>
						<Table.Cell><OutcomePill state="REFUSED" /></Table.Cell>
						<Table.Cell colspan={3} class="text-ink-3">{b.error}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>

	<!-- Phone: the SAME fields, stacked label-value (field parity). -->
	<Card.Content class="p-0 sm:hidden">
		<ul class="divide-y">
			{#each data.runs as run (run.runId)}
				{@const o = worstOutcome(run.counts)}
				<li class="p-4">
					<div class="flex items-center justify-between gap-2">
						<a class="row-link font-mono font-semibold hover:underline" href="/tests/{data.scenario}/{run.runId}">
							{shortRun(run.runId)}
						</a>
						<OutcomePill state={o} />
					</div>
					<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
						<dt class="text-ink-3 text-[0.6875rem] font-medium tracking-wider uppercase">Outcomes</dt>
						<dd class="text-right">
							<CountsBar counts={run.counts} />
							<span class="ml-1 font-mono tabular-nums">
								{run.counts.PASS}·{run.counts.FAIL}·{run.counts.INCONCLUSIVE}
							</span>
						</dd>
						<dt class="text-ink-3 text-[0.6875rem] font-medium tracking-wider uppercase">Target</dt>
						<dd class="text-right"><Badge variant="outline" class="chip">{run.target}</Badge></dd>
						<dt class="text-ink-3 text-[0.6875rem] font-medium tracking-wider uppercase">When</dt>
						<dd class="text-right tabular-nums">{ago(run.createdEpochMs)}</dd>
					</dl>
				</li>
			{/each}
			{#each data.broken as b (b.runId)}
				<li class="p-4">
					<div class="flex items-center justify-between gap-2">
						<span class="font-mono font-semibold">{shortRun(b.runId)}</span>
						<OutcomePill state="REFUSED" />
					</div>
					<p class="text-ink-3 mt-2 text-xs">{b.error}</p>
				</li>
			{/each}
		</ul>
	</Card.Content>

	{#if data.broken.length > 0}
		<div class="text-ink-3 border-t px-4 py-2 text-xs">
			A refused run exists on disk but would not load — drifted from its hash, mislabeled, or
			corrupt. It is shown, not hidden: an intervention to see, not a row to delete.
		</div>
	{/if}
</Card.Root>
