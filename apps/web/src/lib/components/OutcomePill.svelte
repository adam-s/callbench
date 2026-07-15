<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { Outcome } from '$lib/types.ts';

	/**
	 * The three-state outcome (or REFUSED, the not-a-verdict), rendered the one
	 * lawful way: its own hue AND its text label — identity is never color
	 * alone, and INCONCLUSIVE is never a shade of PASS or FAIL. The `pill`/state
	 * classes are stable hooks for the e2e suite.
	 */
	let { state }: { state: Outcome | 'REFUSED' } = $props();
</script>

<Badge variant={state} class="pill {state} text-[0.6875rem]">{state}</Badge>
