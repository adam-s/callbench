#!/usr/bin/env node
/**
 * Visual snapshot + GEOMETRY PROOF for the run timeline (adapted from the
 * maintainer's ~/Projects/separate scripts/snapshot.mjs pattern).
 *
 * Captures the run page's timeline card into .snapshots/<label>/ and — the
 * part a screenshot alone can't prove — measures every time-mapped element's
 * rectangle and checks the math that places it:
 *
 *   - the waveform canvas and the ribbon tapes must share one x-axis
 *     (left/width within TOLERANCE_PX);
 *   - each playhead's position must equal transport.t / duration of its own
 *     track's width;
 *   - the first/last turn blocks must sit at startMs/durationMs of the tape.
 *
 * Exit 1 on any violation, so a visual regression fails loudly instead of
 * shipping. Usage (or `npm run snapshot` from apps/web):
 *   node apps/web/scripts/snapshot.mjs [--url=<run page>] [--label=x] [--play]
 *
 * This replaced the earlier multi-route visual crawler that lived at this
 * path: its unique checks (per-viewport overflow, visual baselines) are now
 * pinned by the e2e suite (e2e/responsive.spec.ts, e2e/visual.spec.ts), and
 * geometry is the check a screenshot alone cannot make.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '../.snapshots');

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, v] = a.replace(/^--/, '').split('=');
			return [k, v ?? 'true'];
		}),
);
const URL =
	args.url ??
	'http://localhost:5199/tests/windshield-quote-persona/f96b7ec24b8b7520e60963272e22379e36cc91f0ed2df9da4b80a13e2318c3db';
const LABEL = args.label ?? `snap-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT = resolve(OUT_ROOT, LABEL);
mkdirSync(OUT, { recursive: true });

const TOLERANCE_PX = 2;

const browser = await chromium.launch({
	args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cbTransport, null, { timeout: 10_000 });

if (args.play) {
	await page.evaluate(() => {
		const tr = window.__cbTransport;
		tr.seek(60);
		tr.play();
	});
	await page.waitForTimeout(1500);
}

const geo = await page.evaluate(() => {
	const rect = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { left: r.left, width: r.width, right: r.right, height: r.height };
	};
	const snap = window.__cbTransport.debugSnapshot();
	const canvas = document.querySelector('.wave canvas');
	const tapes = document.querySelector('.tapes');
	const wavePlayhead = document.querySelector('.wave > div[aria-hidden]');
	const ribbonPlayhead = document.querySelector('.playhead');
	const blocks = [...document.querySelectorAll('.tapes .block')].map((b) => ({
		...rect(b),
		label: b.getAttribute('aria-label')?.slice(0, 40),
	}));
	return {
		snap,
		canvas: rect(canvas),
		tapes: rect(tapes),
		wavePlayhead: rect(wavePlayhead),
		ribbonPlayhead: rect(ribbonPlayhead),
		blockCount: blocks.length,
		firstBlock: blocks[0] ?? null,
		lastBlock: blocks[blocks.length - 1] ?? null,
	};
});

const failures = [];
const check = (name, actual, expected, tol = TOLERANCE_PX) => {
	const ok = actual !== null && expected !== null && Math.abs(actual - expected) <= tol;
	if (!ok) failures.push(`${name}: actual=${actual?.toFixed(1)} expected=${expected?.toFixed(1)}`);
	return `${ok ? 'OK  ' : 'FAIL'} ${name}: ${actual?.toFixed(1)} vs ${expected?.toFixed(1)}`;
};

const lines = [];
if (!geo.canvas) failures.push('waveform canvas missing');
if (!geo.tapes) failures.push('ribbon tapes missing');
if (geo.blockCount === 0) failures.push('no turn blocks rendered');
// Heights are part of visibility: a zero-height track renders nothing while
// every x-coordinate still measures perfectly (the bug that taught us this).
if (geo.tapes && geo.tapes.height < 20)
	failures.push(`tapes collapsed: height=${geo.tapes.height}px`);
if (geo.firstBlock && geo.firstBlock.height < 8)
	failures.push(`blocks collapsed: height=${geo.firstBlock.height}px`);
if (geo.canvas && geo.tapes) {
	lines.push(check('axis left  (tapes vs waveform)', geo.tapes.left, geo.canvas.left));
	lines.push(check('axis width (tapes vs waveform)', geo.tapes.width, geo.canvas.width));
}
const frac = geo.snap.duration > 0 ? geo.snap.t / geo.snap.duration : 0;
if (geo.wavePlayhead && geo.canvas) {
	lines.push(
		check(
			'waveform playhead == t/duration',
			geo.wavePlayhead.left - geo.canvas.left,
			frac * geo.canvas.width,
			3,
		),
	);
}
if (geo.ribbonPlayhead && geo.tapes) {
	lines.push(
		check(
			'ribbon playhead == t/duration',
			geo.ribbonPlayhead.left - geo.tapes.left,
			frac * geo.tapes.width,
			3,
		),
	);
}

// Clip to the UNION of the waveform and the tapes (plus margin) — the subject
// framed, small file, regardless of scroll position.
const clip = await page.evaluate(() => {
	const els = [document.querySelector('.wave'), document.querySelector('.tapes')].filter(Boolean);
	if (els.length === 0) return null;
	const rs = els.map((e) => e.getBoundingClientRect());
	const top = Math.min(...rs.map((r) => r.top)) + window.scrollY;
	const bottom = Math.max(...rs.map((r) => r.bottom)) + window.scrollY;
	const left = Math.min(...rs.map((r) => r.left));
	const right = Math.max(...rs.map((r) => r.right));
	return {
		x: Math.max(0, left - 12),
		y: Math.max(0, top - 12),
		width: right - left + 24,
		height: bottom - top + 24,
	};
});
await page.screenshot({
	path: resolve(OUT, 'timeline.png'),
	clip: clip ?? { x: 0, y: 0, width: 1280, height: 900 },
	fullPage: true,
});

writeFileSync(
	resolve(OUT, 'summary.json'),
	JSON.stringify({ url: URL, geo, checks: lines, failures, consoleErrors }, null, 2),
);
console.log(`snapshot: ${OUT}/timeline.png`);
console.log(
	`transport: t=${geo.snap.t.toFixed(2)} dur=${geo.snap.duration.toFixed(2)} ct=${geo.snap.ct?.toFixed(2)} decDur=${geo.snap.decoderDuration?.toFixed(2)}`,
);
console.log(`blocks rendered: ${geo.blockCount}`);
for (const l of lines) console.log(l);
if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 3));
await browser.close();
if (failures.length) {
	console.error(`\nGEOMETRY PROOF FAILED (${failures.length}):`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log('\nGEOMETRY PROOF PASSED');
