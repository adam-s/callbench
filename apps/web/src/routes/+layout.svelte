<script lang="ts">
	import { page } from '$app/state';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import { shortRun } from '$lib/types.ts';
	import '../app.css';

	let { data, children } = $props();

	// Breadcrumbs derive from route params — one implementation, every page.
	const crumbs = $derived.by(() => {
		const { test, run, finding } = page.params;
		const out: { label: string; href: string | null }[] = [];
		if (test) out.push({ label: test, href: run ? `/tests/${test}` : null });
		if (test && run)
			out.push({ label: shortRun(run), href: finding ? `/tests/${test}/${run}` : null });
		if (finding) out.push({ label: finding, href: null });
		return out;
	});
</script>

<div class="grid min-h-screen grid-rows-[auto_1fr] md:grid-cols-[200px_1fr] md:grid-rows-none">
	<!-- The rail: brand, the map, and the fence note. Collapses to a compact
	     wrapping header bar on phones — same links, restacked, nothing dropped
	     but the prose note. -->
	<nav
		class="bg-card flex flex-row flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 md:sticky md:top-0 md:h-screen md:flex-col md:items-stretch md:gap-4 md:border-r md:border-b-0 md:px-3 md:py-4"
	>
		<a href="/" class="text-foreground font-mono text-sm font-bold">callbench</a>
		<div class="flex flex-row flex-wrap items-center gap-1 md:flex-col md:items-stretch">
			<a
				class="rail-link text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground rounded-md px-2 py-1 text-[0.8125rem] aria-[current=page]:font-semibold"
				href="/"
				aria-current={page.url.pathname === '/' ? 'page' : undefined}
			>
				Overview
			</a>
		</div>
		{#if data.railScenarios.length > 0}
			<div class="flex flex-row flex-wrap items-center gap-1 md:flex-col md:items-stretch">
				<span
					class="text-ink-3 hidden px-2 pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wider uppercase md:block"
				>
					Scenarios
				</span>
				{#each data.railScenarios as s (s)}
					<a
						class="rail-link text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground rounded-md px-2 py-1 font-mono text-[0.8125rem] aria-[current=page]:font-semibold"
						href="/tests/{s}"
						aria-current={page.params.test === s ? 'page' : undefined}
					>
						{s}
					</a>
				{/each}
			</div>
		{/if}
		<p class="rail-foot text-ink-3 mt-auto hidden text-[0.6875rem] leading-snug md:block">
			An evidence viewer. Tests are authored in code; this renders what running them produced.
			Nothing here places a call.
		</p>
	</nav>

	<div class="min-w-0">
		<div class="bg-card flex min-h-11 items-center border-b px-4 py-2 md:px-6">
			<Breadcrumb.Root>
				<Breadcrumb.List class="text-xs">
					<Breadcrumb.Item>
						{#if crumbs.length === 0}
							<Breadcrumb.Page class="font-semibold">callbench</Breadcrumb.Page>
						{:else}
							<Breadcrumb.Link href="/">callbench</Breadcrumb.Link>
						{/if}
					</Breadcrumb.Item>
					{#each crumbs as c (c.label)}
						<Breadcrumb.Separator />
						<Breadcrumb.Item>
							{#if c.href}
								<Breadcrumb.Link href={c.href}>{c.label}</Breadcrumb.Link>
							{:else}
								<Breadcrumb.Page class="font-semibold">{c.label}</Breadcrumb.Page>
							{/if}
						</Breadcrumb.Item>
					{/each}
				</Breadcrumb.List>
			</Breadcrumb.Root>
		</div>
		<div class="mx-auto flex max-w-[1240px] flex-col gap-6 p-4 md:p-6">
			{@render children()}
		</div>
	</div>
</div>
