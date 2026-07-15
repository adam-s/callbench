<script lang="ts">
	import type { Transport } from '$lib/audio/transport.svelte.ts';

	let {
		transport,
		bars = 40,
	}: {
		transport: Transport;
		bars?: number;
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let wrap: HTMLDivElement | undefined = $state();
	let cssW = $state(300);
	const cssH = 44;

	// Peak-hold per bar so the meter has a natural falloff instead of flickering.
	// Allocated lazily inside draw() so it tracks `bars` if it ever changes.
	let peaks: Float32Array | null = null;

	function color(name: string, fallback: string): string {
		if (typeof getComputedStyle === 'undefined' || !canvas) return fallback;
		return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
	}

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

		// Live frequency data — a PROPERTY OF THE FILE being played, never a
		// measured figure (ui.md, two-pipelines). Null when not playing; the meter
		// then simply decays to quiet.
		const fd = transport.freq();
		const accent = color('--accent', '#2a78d6');
		const muted = color('--border', '#ccc');
		const gap = 2;
		const bw = (w - gap * (bars - 1)) / bars;
		const len = fd ? fd.length : 0;
		if (!peaks || peaks.length !== bars) peaks = new Float32Array(bars);

		for (let i = 0; i < bars; i++) {
			// Map bar i to a log-ish slice of the spectrum so speech energy spreads
			// across the meter rather than bunching at the low end.
			let v = 0;
			if (fd && len > 0) {
				const lo = Math.floor((i / bars) ** 1.5 * len);
				const hi = Math.max(lo + 1, Math.floor(((i + 1) / bars) ** 1.5 * len));
				let m = 0;
				for (let b = lo; b < hi && b < len; b++) m = Math.max(m, (fd[b] as number) / 255);
				v = m;
			}
			// decay the peak-hold toward the current value
			peaks[i] = Math.max(v, (peaks[i] as number) - 0.04);
			const bh = Math.max(1, (peaks[i] as number) * (h - 2));
			const x = i * (bw + gap);
			ctx.fillStyle = (peaks[i] as number) > 0.02 ? accent : muted;
			ctx.globalAlpha = (peaks[i] as number) > 0.02 ? 0.85 : 0.3;
			ctx.fillRect(x, h - bh, bw, bh);
		}
		ctx.globalAlpha = 1;
	}

	$effect(() => {
		transport.frame; // the one clock — redraw each tick while playing
		void cssW;
		draw();
	});

	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) cssW = Math.max(120, e.contentRect.width);
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});
</script>

<div class="meter" bind:this={wrap} title="Live spectrum — a property of the recording, never a measured figure">
	<canvas bind:this={canvas} style:width="100%" style:height="{cssH}px"></canvas>
</div>

<style>
	.meter {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: var(--r-3);
		/* recessed like the ribbon tracks, so the meter reads as an instrument
		 * awaiting signal rather than an empty white box before first play */
		background: var(--surface-2);
		overflow: hidden;
	}
	canvas {
		display: block;
	}
</style>
