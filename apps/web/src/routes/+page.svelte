<script lang="ts">
	import OutcomePill from '$lib/components/OutcomePill.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { worstOutcome, type Outcome } from '$lib/types.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	const totalRuns = $derived(data.scenarios.reduce((n, s) => n + s.runCount, 0));
	const totalBroken = $derived(data.scenarios.reduce((n, s) => n + s.brokenCount, 0));
	const cleanRuns = $derived(
		data.scenarios.reduce((n, s) => n + Math.round(s.cleanRate * s.runCount), 0),
	);

	// Worst-first: a scenario whose latest run failed outranks one that passed;
	// INCONCLUSIVE sits between, as its own state. Ties break to most recent.
	const SEVERITY: Record<Outcome, number> = { FAIL: 0, INCONCLUSIVE: 1, PASS: 2 };
	const rows = $derived(
		[...data.scenarios].sort((a, b) => {
			const ao = a.latest ? SEVERITY[worstOutcome(a.latest.counts)] : 3;
			const bo = b.latest ? SEVERITY[worstOutcome(b.latest.counts)] : 3;
			if (ao !== bo) return ao - bo;
			return (b.latest?.createdEpochMs ?? 0) - (a.latest?.createdEpochMs ?? 0);
		}),
	);

	function pct(x: number): string {
		return `${Math.round(x * 100)}%`;
	}

	function ago(epochMs: number): string {
		const s = Math.max(0, (Date.now() - epochMs) / 1000);
		if (s < 90) return 'just now';
		if (s < 5400) return `${Math.round(s / 60)}m ago`;
		if (s < 129600) return `${Math.round(s / 3600)}h ago`;
		return `${Math.round(s / 86400)}d ago`;
	}

	const TILES = $derived([
		{ label: 'Scenarios', value: String(data.scenarios.length), sub: null, alarm: false },
		{ label: 'Runs', value: String(totalRuns), sub: null, alarm: false },
		{
			label: 'Clean runs',
			value: totalRuns > 0 ? pct(cleanRuns / totalRuns) : '—',
			sub: 'every assertion PASS',
			alarm: false,
		},
		{
			label: 'Refused artifacts',
			value: String(totalBroken),
			sub: 'on disk but would not load',
			alarm: totalBroken > 0,
		},
	]);
</script>

<svelte:head>
	<title>Overview · callbench</title>
	<meta
		name="description"
		content="callbench evidence viewer — every scenario with run evidence on disk, worst first."
	/>
</svelte:head>

<div class="page-head flex flex-wrap items-baseline gap-3">
	<h1 class="text-xl font-semibold tracking-tight">Overview</h1>
	<p class="sub text-muted-foreground text-[0.8125rem]">
		Every scenario with evidence on disk, worst first.
	</p>
</div>

{#if data.scenarios.length === 0}
	<Card.Root>
		<Card.Content class="text-ink-3">
			No runs on disk yet. Generate the fixtures, or record a run.
		</Card.Content>
	</Card.Root>
{:else}
	<div class="tiles grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each TILES as tile (tile.label)}
			<Card.Root class="tile gap-0 py-3">
				<Card.Content class="px-4">
					<div class="tile-label text-ink-3 text-[0.6875rem] font-semibold tracking-wider uppercase">
						{tile.label}
					</div>
					<div class="tile-value text-2xl font-semibold {tile.alarm ? 'text-fail' : ''}">
						{tile.value}
					</div>
					{#if tile.sub}<div class="text-muted-foreground mt-0.5 text-xs">{tile.sub}</div>{/if}
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b px-4 !py-3">
			<Card.Title class="text-base">Scenarios</Card.Title>
		</Card.Header>

		<!-- Desktop/tablet: the dense table. -->
		<Card.Content class="hidden p-0 sm:block">
			<Table.Root class="table">
				<Table.Header>
					<Table.Row class="bg-muted hover:bg-muted">
						<Table.Head>Scenario</Table.Head>
						<Table.Head>Latest</Table.Head>
						<Table.Head class="text-right">Runs</Table.Head>
						<Table.Head class="text-right">Clean</Table.Head>
						<Table.Head class="text-right">Refused</Table.Head>
						<Table.Head class="text-right">Last run</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as s (s.scenario)}
						<Table.Row>
							<Table.Cell>
								<a class="row-link font-mono font-semibold hover:underline" href="/tests/{s.scenario}">
									{s.scenario}
								</a>
							</Table.Cell>
							<Table.Cell>
								{#if s.latest}<OutcomePill state={worstOutcome(s.latest.counts)} />{:else}—{/if}
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{s.runCount}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{pct(s.cleanRate)}</Table.Cell>
							<Table.Cell class="text-right">
								{#if s.brokenCount > 0}
									<OutcomePill state="REFUSED" />
									<span class="tabular-nums">{s.brokenCount}</span>
								{:else}
									<span class="text-ink-3 tabular-nums">0</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-ink-3 num muted text-right tabular-nums">
								{s.latest ? ago(s.latest.createdEpochMs) : '—'}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>

		<!-- Phone: the SAME fields, stacked label-value — nothing hidden behind
		     a horizontal scroll (field parity with the table above). -->
		<Card.Content class="p-0 sm:hidden">
			<ul class="divide-y">
				{#each rows as s (s.scenario)}
					<li class="p-4">
						<div class="flex items-center justify-between gap-2">
							<a class="row-link font-mono font-semibold hover:underline" href="/tests/{s.scenario}">
								{s.scenario}
							</a>
							{#if s.latest}<OutcomePill state={worstOutcome(s.latest.counts)} />{/if}
						</div>
						<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
							<dt class="text-ink-3 font-medium uppercase tracking-wider text-[0.6875rem]">Runs</dt>
							<dd class="text-right tabular-nums">{s.runCount}</dd>
							<dt class="text-ink-3 font-medium uppercase tracking-wider text-[0.6875rem]">Clean</dt>
							<dd class="text-right tabular-nums">{pct(s.cleanRate)}</dd>
							<dt class="text-ink-3 font-medium uppercase tracking-wider text-[0.6875rem]">Refused</dt>
							<dd class="text-right">
								{#if s.brokenCount > 0}<OutcomePill state="REFUSED" /> {s.brokenCount}{:else}0{/if}
							</dd>
							<dt class="text-ink-3 font-medium uppercase tracking-wider text-[0.6875rem]">Last run</dt>
							<dd class="text-right tabular-nums">{s.latest ? ago(s.latest.createdEpochMs) : '—'}</dd>
						</dl>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
