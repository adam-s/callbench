#!/usr/bin/env node
/**
 * CDP performance profile for the evidence viewer — ported from the
 * maintainer's ~/Projects/hnswered/scripts/perf-profile.mjs pattern
 * (Performance.getMetrics deltas + Profiler hot-function sampling).
 *
 * Two measurements per run, both against the committed fixtures:
 *
 *  1. ROUTE LOADS — for each route: navigation timing (FCP, DCL, load),
 *     CDP metric deltas (script duration, layout count, style recalcs, DOM
 *     nodes), and the hottest functions by CPU sample.
 *  2. PLAYBACK STRESS — on the run page, start span playback and profile the
 *     rAF render loop (waveform + ribbon + meter redraw each tick) for a
 *     fixed window. This is the app's real per-frame cost, and the number to
 *     watch when touching canvas code.
 *
 * IMPORTANT: these figures describe the VIEWER's rendering cost. They are
 * browser-side numbers about our own UI and may never be reported as
 * measurements of a call or of the system under test (the two-pipelines rule
 * in docs/ui.md).
 *
 * Bounded (fixed route list, fixed stress window), deterministic in output
 * shape; writes .perf/<label>/results.json. Not part of the static gate.
 *
 * Usage:
 *   node scripts/perf-profile.mjs [--url=http://localhost:5173] [--label=baseline]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, v] = a.replace(/^--/, '').split('=');
			return [k, v ?? 'true'];
		}),
);

const BASE = (args.url ?? 'http://localhost:5173').replace(/\/$/, '');
const LABEL = args.label ?? `perf-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT = resolve(ROOT, '.perf', LABEL);
mkdirSync(OUT, { recursive: true });

const SCENARIO = 'windshield-quote';
const FAIL_RUN = '3cd98cde9bc1edb02970a32e406772da57b12684217cd37ab7f99d3a3f92b5a8';
const ROUTES = [
	'/',
	`/tests/${SCENARIO}`,
	`/tests/${SCENARIO}/${FAIL_RUN}`,
	`/tests/${SCENARIO}/${FAIL_RUN}/no-fabricated-recalibration`,
];
const STRESS_MS = 4_000;

function getMetric(m, name) {
	const x = m.metrics.find((e) => e.name === name);
	return x ? x.value : 0;
}
function metricsDelta(before, after) {
	return {
		scriptDuration_ms: Number(
			((getMetric(after, 'ScriptDuration') - getMetric(before, 'ScriptDuration')) * 1000).toFixed(
				2,
			),
		),
		layoutCount: getMetric(after, 'LayoutCount') - getMetric(before, 'LayoutCount'),
		recalcStyleCount: getMetric(after, 'RecalcStyleCount') - getMetric(before, 'RecalcStyleCount'),
		domNodes: getMetric(after, 'Nodes'),
	};
}
function topFunctions(profile, limit = 10) {
	if (!profile?.nodes || !profile.samples) return [];
	const idToNode = new Map();
	for (const n of profile.nodes) idToNode.set(n.id, n);
	const counts = new Map();
	for (const sid of profile.samples) {
		const n = idToNode.get(sid);
		if (!n) continue;
		const cf = n.callFrame;
		const file = cf.url ? cf.url.split('/').pop() : '(anon)';
		const key = `${cf.functionName || '(anonymous)'} (${file}:${cf.lineNumber})`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const total = profile.samples.length || 1;
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([name, samples]) => ({
			name,
			samples,
			pct: Number(((samples / total) * 100).toFixed(1)),
		}));
}

async function profileRoute(browser, route) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await cdp.send('Profiler.enable');

	const before = await cdp.send('Performance.getMetrics');
	await cdp.send('Profiler.start');
	const t0 = Date.now();
	await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30_000 });
	await page.waitForTimeout(200);
	const elapsed = Date.now() - t0;
	const { profile } = await cdp.send('Profiler.stop');
	const after = await cdp.send('Performance.getMetrics');

	const timing = await page.evaluate(() => {
		const paint = performance.getEntriesByType('paint');
		const nav = performance.getEntriesByType('navigation')[0];
		return {
			firstContentfulPaint_ms:
				paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null,
			domContentLoaded_ms: nav?.domContentLoadedEventEnd ?? null,
			loadComplete_ms: nav?.loadEventEnd ?? null,
		};
	});

	await cdp.detach();
	await page.close();
	return {
		route,
		elapsed_ms: elapsed,
		timing,
		metrics: metricsDelta(before, after),
		hotFunctions: topFunctions(profile),
	};
}

/** Profile the render loop while a span plays: rAF drives waveform, ribbon,
 * and meter redraws off the one clock. Wall-clock fallback keeps this honest
 * even where headless audio is silent. */
async function profilePlayback(browser) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`${BASE}/tests/${SCENARIO}/${FAIL_RUN}`, {
		waitUntil: 'networkidle',
		timeout: 30_000,
	});

	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await cdp.send('Profiler.enable');

	// Start playback from the top, then profile a fixed window of the loop.
	await page.locator('.controls .play').click();
	await page.waitForTimeout(300); // let the loop reach steady state
	const before = await cdp.send('Performance.getMetrics');
	await cdp.send('Profiler.start');
	// Sample rAF deltas in-page for the whole stress window — smoothness as a
	// measured number (fps, p95 frame time, long frames), never an assertion.
	const frames = await page.evaluate(
		(windowMs) =>
			new Promise((resolveFrames) => {
				const deltas = [];
				let last = performance.now();
				const t0 = last;
				function tick(now) {
					deltas.push(now - last);
					last = now;
					if (now - t0 < windowMs) requestAnimationFrame(tick);
					else resolveFrames(deltas);
				}
				requestAnimationFrame(tick);
			}),
		STRESS_MS,
	);
	const { profile } = await cdp.send('Profiler.stop');
	const after = await cdp.send('Performance.getMetrics');

	const sorted = [...frames].sort((a, b) => a - b);
	const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const frameTiming = {
		frames: frames.length,
		fps: Number((frames.length / (STRESS_MS / 1000)).toFixed(1)),
		p50FrameMs: Number(p(0.5).toFixed(2)),
		p95FrameMs: Number(p(0.95).toFixed(2)),
		// a frame past ~2 vsyncs is a visible hitch; count them, don't average them
		longFrames: frames.filter((d) => d > 33.4).length,
	};

	const delta = metricsDelta(before, after);
	await cdp.detach();
	await page.close();
	return {
		windowMs: STRESS_MS,
		metrics: delta,
		// script ms per second of playback — the budget number for canvas work
		scriptMsPerSecond: Number((delta.scriptDuration_ms / (STRESS_MS / 1000)).toFixed(2)),
		frameTiming,
		hotFunctions: topFunctions(profile),
	};
}

async function main() {
	console.log(
		`\ncallbench viewer perf-profile\nurl:    ${BASE}\nlabel:  ${LABEL}\noutput: ${OUT}\n`,
	);
	const browser = await chromium.launch({ headless: true });

	const routes = [];
	for (const route of ROUTES) {
		process.stdout.write(`  load ${route.padEnd(44).slice(0, 44)} `);
		const r = await profileRoute(browser, route);
		routes.push(r);
		console.log(
			`fcp=${r.timing.firstContentfulPaint_ms?.toFixed(0) ?? '—'}ms script=${r.metrics.scriptDuration_ms}ms layouts=${r.metrics.layoutCount} nodes=${r.metrics.domNodes}`,
		);
	}

	process.stdout.write(`  playback stress (${STRESS_MS}ms)... `);
	const playback = await profilePlayback(browser);
	console.log(
		`script=${playback.metrics.scriptDuration_ms}ms (${playback.scriptMsPerSecond}ms/s) layouts=${playback.metrics.layoutCount}`,
	);
	console.log(
		`  frame timing: ${playback.frameTiming.fps}fps p50=${playback.frameTiming.p50FrameMs}ms p95=${playback.frameTiming.p95FrameMs}ms longFrames=${playback.frameTiming.longFrames}`,
	);

	await browser.close();

	console.log('\n--- playback hot functions ---');
	for (const f of playback.hotFunctions.slice(0, 6)) {
		console.log(`  ${String(f.pct).padStart(5)}%  ${f.name}`);
	}

	const summary = {
		label: LABEL,
		url: BASE,
		timestamp: new Date().toISOString(),
		routes,
		playback,
	};
	writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(summary, null, 2));
	console.log(`\nresults: ${resolve(OUT, 'results.json')}\n`);
}

main().catch((err) => {
	console.error('perf-profile failed:', err);
	process.exit(1);
});
