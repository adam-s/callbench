<script lang="ts">
	import type { Transport } from '$lib/audio/transport.svelte.ts';

	export interface RibbonTurn {
		speaker: 'bench' | 'target';
		text: string;
		startMs: number;
		endMs: number;
	}

	let {
		turns,
		durationMs,
		transport = null,
	}: {
		turns: readonly RibbonTurn[];
		durationMs: number;
		transport?: Transport | null;
	} = $props();

	const durMs = $derived(Math.max(1, durationMs));

	// ui.md's highest-value view: two lanes on a real time axis. One glance shows
	// the rhythm — who spoke, how long the gaps were, and (for a real call) where
	// the two OVERLAP, which is literal talkover. The simulator never talks over
	// itself, so no overlap shows here — which is honest, not a missing feature.
	const pct = (ms: number) => `${(ms / durMs) * 100}%`;

	// The turn under the playhead, so the ribbon block lights up in lockstep with
	// the waveform and the transcript. Reads the one clock.
	const playingIndex = $derived.by(() => {
		if (!transport) return -1;
		const ms = transport.t * 1000;
		return turns.findIndex((t) => ms >= t.startMs && ms < t.endMs);
	});

	const playheadPct = $derived(transport ? `${(((transport.t * 1000) / durMs) * 100).toFixed(3)}%` : '0%');

	function seekTo(startMs: number) {
		transport?.seek(startMs / 1000);
	}
</script>

<div class="ribbon">
	{#each ['bench', 'target'] as const as lane (lane)}
		<div class="lane">
			<span class="lane-label {lane}">{lane === 'bench' ? 'BENCH' : 'AGENT'}</span>
			<div class="track">
				{#each turns as turn, i (i)}
					{#if turn.speaker === lane}
						<button
							class="block {lane}"
							class:playing={i === playingIndex}
							style:left={pct(turn.startMs)}
							style:width={pct(Math.max(1, turn.endMs - turn.startMs))}
							title={turn.text}
							aria-label="{lane} turn: {turn.text}"
							onclick={() => seekTo(turn.startMs)}
						></button>
					{/if}
				{/each}
			</div>
		</div>
	{/each}
	{#if transport}
		<div class="playhead" style:left={playheadPct}></div>
	{/if}
</div>

<style>
	.ribbon {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.5rem 0;
	}
	.lane {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.lane-label {
		flex: none;
		width: 3.4rem;
		font-family: var(--mono);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-align: right;
	}
	.lane-label.bench {
		color: var(--bench);
	}
	.lane-label.target {
		color: var(--target);
	}
	.track {
		position: relative;
		flex: 1;
		height: 1.4rem;
		background: var(--surface-2);
		border-radius: 4px;
		overflow: hidden;
	}
	.block {
		position: absolute;
		top: 2px;
		bottom: 2px;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		padding: 0;
		min-width: 2px;
		opacity: 0.75;
	}
	.block:hover {
		opacity: 1;
	}
	.block.bench {
		background: var(--bench);
	}
	.block.target {
		background: var(--target);
	}
	.block.playing {
		opacity: 1;
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		/* offset by the lane label column so it lines up with the tracks */
		margin-left: 4rem;
		width: 1.5px;
		background: var(--accent);
		pointer-events: none;
	}
</style>
