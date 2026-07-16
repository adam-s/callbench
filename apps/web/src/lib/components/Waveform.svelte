<script lang="ts">
	import type { Transport } from '$lib/audio/transport.svelte.ts';
	import { fmtTime as fmt } from '$lib/format.ts';
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

	// The playhead is an OVERLAY, not a canvas stroke (pattern from the
	// maintainer's ~/Projects/separate MelSpectrogram/Playhead): the canvas
	// below draws the STATIC picture — peaks, finding spans, the cited outline —
	// and repaints only when data or size changes. Moving the playhead each rAF
	// tick updates one element's `left`, which the compositor handles without
	// touching the canvas at all.
	const playFrac = $derived(Math.max(0, Math.min(1, transport.t / durSec)));

	// Hover: a ghost line + time readout following the cursor, so click-to-seek
	// says where it will land before it is clicked. Pure overlay, no redraw.
	let hoverFrac = $state<number | null>(null);

	// Colors read from the page's CSS custom properties so the waveform matches
	// the app vocabulary instead of hardcoding hexes.
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
			ctx.strokeStyle = color('--accent', '#2a78d6');
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
	}

	// Repaint the STATIC picture only when its inputs change — never per
	// playback frame (the playhead overlay carries the motion).
	$effect(() => {
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

	function fracFromEvent(e: MouseEvent): number {
		if (!canvas) return 0;
		const rect = canvas.getBoundingClientRect();
		return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
	}
</script>

<div class="wave relative w-full overflow-hidden rounded-lg border bg-card" bind:this={wrap}>
	<!-- click-to-seek: playback of a recording, never a dial -->
	<canvas
		bind:this={canvas}
		class="block w-full cursor-pointer"
		style:height="{cssH}px"
		onclick={(e) => transport.seek(fracFromEvent(e) * durSec)}
		onmousemove={(e) => (hoverFrac = fracFromEvent(e))}
		onmouseleave={() => (hoverFrac = null)}
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

	<!-- playhead: one composited element, no canvas repaint per frame -->
	<div
		class="pointer-events-none absolute inset-y-0 w-[1.5px] bg-[var(--accent)] will-change-[left]"
		style:left="{playFrac * 100}%"
		aria-hidden="true"
	></div>

	{#if hoverFrac !== null}
		<div
			class="pointer-events-none absolute inset-y-0 w-px bg-[var(--ink-3)] opacity-60"
			style:left="{hoverFrac * 100}%"
			aria-hidden="true"
		></div>
		<div
			class="pointer-events-none absolute top-1 rounded border bg-card px-1 font-mono text-[0.6875rem] text-muted-foreground"
			style:left="{hoverFrac * 100}%"
			style:transform="translateX({hoverFrac > 0.9 ? '-100%' : '4px'})"
			aria-hidden="true"
		>
			{fmt(hoverFrac * durSec)}
		</div>
	{/if}
</div>

<!-- time axis: the frozen timeline's endpoints, from the artifact's duration -->
<div class="text-ink-3 mt-1 flex justify-between font-mono text-[0.6875rem]" aria-hidden="true">
	<span>0:00</span>
	<span>{fmt(durSec)}</span>
</div>
