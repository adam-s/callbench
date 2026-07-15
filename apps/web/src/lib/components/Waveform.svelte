<script lang="ts">
	import type { Transport } from '$lib/audio/transport.svelte.ts';
	import type { Outcome } from '$lib/types.ts';

	export interface WaveSpan {
		startMs: number;
		endMs: number;
		outcome: Outcome;
		assertion: string;
	}

	let {
		transport,
		peaks,
		durationMs,
		spans = [],
		cited = null,
	}: {
		transport: Transport;
		peaks: ReadonlyArray<readonly [number, number]>;
		durationMs: number;
		spans?: WaveSpan[];
		cited?: { startMs: number; endMs: number } | null;
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let wrap: HTMLDivElement | undefined = $state();
	let cssW = $state(600);
	const cssH = 120;

	const durSec = $derived(Math.max(0.001, durationMs / 1000));

	// Colors read from the page's CSS custom properties so the waveform matches
	// the app vocabulary (and light/dark) instead of hardcoding hexes.
	function color(name: string, fallback: string): string {
		if (typeof getComputedStyle === 'undefined' || !canvas) return fallback;
		const v = getComputedStyle(canvas).getPropertyValue(name).trim();
		return v || fallback;
	}
	const OUTCOME_VAR: Record<Outcome, string> = {
		PASS: '--pass',
		FAIL: '--fail',
		INCONCLUSIVE: '--inconclusive',
	};

	function draw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
		const w = cssW;
		const h = cssH;
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		const xOf = (ms: number) => (ms / 1000 / durSec) * w;

		// span tints — a finding's moment on the timeline, colored by outcome
		for (const s of spans) {
			const x0 = xOf(s.startMs);
			const x1 = Math.max(x0 + 1.5, xOf(s.endMs));
			ctx.fillStyle = color(OUTCOME_VAR[s.outcome], '#8888');
			ctx.globalAlpha = 0.16;
			ctx.fillRect(x0, 0, x1 - x0, h);
			ctx.globalAlpha = 1;
		}

		// the cited span (deep link) — outlined so the reader lands on it
		if (cited) {
			const x0 = xOf(cited.startMs);
			const x1 = Math.max(x0 + 2, xOf(cited.endMs));
			ctx.strokeStyle = color('--accent', '#2b6cb0');
			ctx.lineWidth = 1.5;
			ctx.strokeRect(x0 + 0.5, 1, x1 - x0 - 1, h - 2);
		}

		// the waveform envelope from server-computed peaks
		const mid = h / 2;
		const wave = color('--ink-2', '#666');
		ctx.strokeStyle = wave;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const cols = peaks.length;
		for (let i = 0; i < cols; i++) {
			const x = (i / cols) * w + 0.5;
			const [min, max] = peaks[i] as readonly [number, number];
			ctx.moveTo(x, mid - max * (mid - 2));
			ctx.lineTo(x, mid - min * (mid - 2));
		}
		ctx.stroke();

		// playhead
		const px = (transport.t / durSec) * w;
		ctx.strokeStyle = color('--accent', '#2b6cb0');
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(px + 0.5, 0);
		ctx.lineTo(px + 0.5, h);
		ctx.stroke();
	}

	// Redraw once per clock tick (playhead) and whenever inputs change.
	$effect(() => {
		transport.frame; // dependency: the single clock
		void cssW;
		void peaks;
		void spans;
		void cited;
		draw();
	});

	// Track width so the canvas fills its container crisply.
	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) cssW = Math.max(120, e.contentRect.width);
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	function seekFromEvent(e: MouseEvent) {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		transport.seek(frac * durSec);
	}
</script>

<div class="wave" bind:this={wrap}>
	<!-- click-to-seek: playback of a recording, never a dial -->
	<canvas
		bind:this={canvas}
		style:width="100%"
		style:height="{cssH}px"
		onclick={seekFromEvent}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') transport.toggle();
		}}
		role="slider"
		tabindex="0"
		aria-label="Waveform — click to seek"
		aria-valuemin={0}
		aria-valuemax={Math.round(durSec)}
		aria-valuenow={Math.round(transport.t)}
	></canvas>
</div>

<style>
	.wave {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		overflow: hidden;
	}
	canvas {
		display: block;
		cursor: pointer;
	}
</style>
