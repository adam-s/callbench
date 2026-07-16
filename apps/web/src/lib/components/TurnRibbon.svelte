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

<!-- Labels live in a LEGEND, not the time axis: a label column inside the row
     shifted and compressed the tapes' scale relative to the waveform above,
     and the playhead — a percentage of the full row — ran on a wider scale
     than the tapes it crossed (maintainer-seen as a fast cursor, worst near
     the end). The tapes now span the same full width as the waveform, and
     every percentage shares that one axis. -->
<div class="ribbon">
	<div class="legend" aria-hidden="true">
		<span class="key"><i class="swatch bench"></i>BENCH</span>
		<span class="key"><i class="swatch target"></i>AGENT</span>
	</div>
	<div class="tapes">
		{#each ['bench', 'target'] as const as lane (lane)}
			<div class="track">
				{#each turns as turn, i (i)}
					{#if turn.speaker === lane}
						<button
							class="block {lane}"
							class:playing={i === playingIndex}
							style:left={pct(turn.startMs)}
							style:width={pct(Math.max(1, turn.endMs - turn.startMs))}
							title={turn.text}
							aria-label="{lane === 'bench' ? 'BENCH' : 'AGENT'} turn: {turn.text}"
							onclick={() => seekTo(turn.startMs)}
						></button>
					{/if}
				{/each}
			</div>
		{/each}
		{#if transport}
			<div class="playhead" style:left={playheadPct}></div>
		{/if}
	</div>
</div>

<style>
	.ribbon {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.5rem 0;
	}
	.legend {
		display: flex;
		gap: 1rem;
		font-family: var(--mono);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.swatch {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		display: inline-block;
	}
	.swatch.bench {
		background: var(--bench);
	}
	.swatch.target {
		background: var(--target);
	}
	.key:first-child {
		color: var(--bench);
	}
	.key:last-child {
		color: var(--target);
	}
	.tapes {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
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
		width: 1.5px;
		background: var(--accent);
		pointer-events: none;
	}
</style>
