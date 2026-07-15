<script lang="ts">
	import type { Counts } from '$lib/types.ts';

	/**
	 * One run's three-state outcome as a single segmented mark, proportional by
	 * count, 2px surface gaps between segments. Color alone never carries it:
	 * the accessible name and the adjacent numeric text (rendered by callers)
	 * state the same numbers.
	 */
	let { counts }: { counts: Counts } = $props();

	const total = $derived(counts.PASS + counts.FAIL + counts.INCONCLUSIVE);
	const label = $derived(
		`PASS ${counts.PASS} · FAIL ${counts.FAIL} · INCONCLUSIVE ${counts.INCONCLUSIVE}`,
	);
	const SEG_CLASS = {
		PASS: 'bg-pass',
		FAIL: 'bg-fail',
		INCONCLUSIVE: 'bg-inconclusive',
	} as const;
</script>

{#if total > 0}
	<span
		class="countsbar inline-flex h-2 w-24 gap-[2px] overflow-hidden rounded-[2px] align-middle"
		role="img"
		aria-label={label}
		title={label}
	>
		{#each ['PASS', 'FAIL', 'INCONCLUSIVE'] as const as k (k)}
			{#if counts[k] > 0}
				<span class="min-w-[3px] {SEG_CLASS[k]}" style:flex-grow={counts[k]}></span>
			{/if}
		{/each}
	</span>
{/if}
