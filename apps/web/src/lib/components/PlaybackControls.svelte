<script lang="ts">
	import type { Transport } from '$lib/audio/transport.svelte.ts';

	let { transport }: { transport: Transport } = $props();

	function fmt(sec: number): string {
		if (!Number.isFinite(sec)) return '0:00';
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
</script>

<div class="controls">
	<button class="play" onclick={() => transport.toggle()} aria-label={transport.playing ? 'Pause' : 'Play'}>
		{#if transport.playing}❚❚{:else}▶{/if}
	</button>
	<input
		class="scrub"
		type="range"
		min="0"
		max={transport.duration || 0}
		step="0.01"
		value={transport.t}
		oninput={(e) => transport.seek(+e.currentTarget.value)}
		aria-label="Seek"
	/>
	<span class="time mono">{fmt(transport.t)} / {fmt(transport.duration)}</span>
</div>

<style>
	.controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.play {
		flex: none;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.play:hover {
		background: var(--surface-2);
	}
	.scrub {
		flex: 1;
		accent-color: var(--accent);
	}
	.time {
		flex: none;
		font-size: 0.8rem;
		color: var(--ink-2);
		min-width: 5.5rem;
		text-align: right;
	}
</style>
