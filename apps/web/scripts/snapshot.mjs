#!/usr/bin/env node
/**
 * Visual snapshot tool for iterative UI work — ported from the maintainer's
 * ~/Projects/separate/scripts/snapshot.mjs and adapted to a multi-route app.
 *
 * Discovers the viewer's routes from the running app itself (overview → first
 * scenario → its runs → each run's findings, hard-capped), then captures each
 * route in three viewports: full-page + above-the-fold JPEGs, console/page/
 * network errors, and horizontal-overflow metrics. Everything lands in
 * .snapshots/<label>/ with a summary.json and a CLEAN / ISSUES FOUND verdict.
 *
 * Bounded by construction (route cap, viewport list, per-nav timeout) and
 * deterministic in output shape — a dynamic script per AGENTS.md, never part
 * of the static gate. It drives a localhost page over frozen fixtures; it
 * dials nothing.
 *
 * Usage:
 *   node scripts/snapshot.mjs [--url=http://localhost:5173]
 *                             [--label=iter-01] [--routes=/,/tests/foo]
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
const LABEL = args.label ?? `snap-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT_DIR = resolve(ROOT, '.snapshots', LABEL);
const MAX_ROUTES = 12; // hard cap — a runaway crawl is a bug, not thoroughness
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
	{ name: 'desktop', width: 1440, height: 900 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'mobile', width: 375, height: 812 },
];

/** Walk the app's own links: / → scenarios → runs → findings. Same-origin
 * hrefs only, capped, order-stable. The app is the map; no route list to
 * maintain by hand. */
async function discoverRoutes(browser) {
	if (args.routes) return args.routes.split(',').slice(0, MAX_ROUTES);
	const page = await browser.newPage();
	const seen = new Set(['/']);
	const queue = ['/'];
	for (const route of queue) {
		if (seen.size >= MAX_ROUTES) break;
		await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 15_000 });
		const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')));
		for (const href of hrefs) {
			if (!href || href.endsWith('/audio') || seen.has(href)) continue;
			if (seen.size >= MAX_ROUTES) break;
			seen.add(href);
			queue.push(href);
		}
	}
	await page.close();
	return [...seen];
}

async function capture(browser, route, viewport) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		// 1x on purpose: these shots are read by a coding agent, which downscales
		// anything wide anyway — retina doubling quadruples bytes for zero added
		// legibility. CSS-pixel capture + JPEG below keeps each shot small.
		deviceScaleFactor: 1,
		isMobile: viewport.name === 'mobile',
		hasTouch: viewport.name !== 'desktop',
	});
	const page = await context.newPage();

	const consoleErrors = [];
	const pageErrors = [];
	const networkErrors = [];
	page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
	page.on('pageerror', (e) => pageErrors.push(e.message));
	page.on('requestfailed', (r) =>
		networkErrors.push({ url: r.url(), error: r.failure()?.errorText }),
	);
	page.on(
		'response',
		(r) => r.status() >= 400 && networkErrors.push({ url: r.url(), status: r.status() }),
	);

	const slug = route === '/' ? 'overview' : route.replace(/^\/|\/$/g, '').replace(/\//g, '_');
	try {
		await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30_000 });
	} catch (err) {
		await context.close();
		return { route, viewport: viewport.name, error: `navigation failed: ${err.message}` };
	}

	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(300);

	// JPEG at q80: on these UI shots it is ~5-10x smaller than PNG with text
	// still crisp at 1x — the cheapest form a coding agent can actually read.
	await page.screenshot({
		path: resolve(OUT_DIR, `${slug}--${viewport.name}-full.jpg`),
		fullPage: true,
		type: 'jpeg',
		quality: 80,
		scale: 'css',
	});
	await page.screenshot({
		path: resolve(OUT_DIR, `${slug}--${viewport.name}-fold.jpg`),
		fullPage: false,
		type: 'jpeg',
		quality: 80,
		scale: 'css',
	});

	const metrics = await page.evaluate(() => {
		const b = document.body;
		const h = document.documentElement;
		const sw = Math.max(b.scrollWidth, h.scrollWidth);
		return {
			scrollWidth: sw,
			clientWidth: h.clientWidth,
			hasHorizontalScroll: sw > h.clientWidth + 1,
			scrollHeight: Math.max(b.scrollHeight, h.scrollHeight),
			h1: document.querySelector('h1')?.textContent?.trim().slice(0, 120) ?? null,
		};
	});

	await context.close();
	return {
		route,
		viewport: viewport.name,
		size: `${viewport.width}x${viewport.height}`,
		metrics,
		consoleErrors,
		pageErrors,
		networkErrors,
	};
}

async function main() {
	const browser = await chromium.launch({ headless: true });
	const routes = await discoverRoutes(browser);
	console.log(
		`\nSnapshot: ${BASE}\nLabel:    ${LABEL}\nRoutes:   ${routes.length} (cap ${MAX_ROUTES})\nOutput:   ${OUT_DIR}\n`,
	);

	const results = [];
	for (const route of routes) {
		for (const vp of VIEWPORTS) {
			process.stdout.write(`  ${route.padEnd(44).slice(0, 44)} ${vp.name.padEnd(8)}... `);
			const r = await capture(browser, route, vp);
			results.push(r);
			if (r.error) {
				console.log(`ERROR: ${r.error}`);
			} else {
				const errs = r.consoleErrors.length + r.pageErrors.length + r.networkErrors.length;
				console.log(`OK  errors=${errs}${r.metrics.hasHorizontalScroll ? ' [H-OVERFLOW]' : ''}`);
			}
		}
	}
	await browser.close();

	writeFileSync(
		resolve(OUT_DIR, 'summary.json'),
		JSON.stringify({ url: BASE, label: LABEL, routes, results }, null, 2),
	);

	console.log('\n--- Report ---');
	let clean = true;
	for (const r of results) {
		const errs = r.error
			? 1
			: r.consoleErrors.length + r.pageErrors.length + r.networkErrors.length;
		if (errs || r.metrics?.hasHorizontalScroll) {
			clean = false;
			console.log(`\n[${r.route} @ ${r.viewport}]`);
			if (r.error) console.log(`  ${r.error}`);
			if (r.consoleErrors?.length) console.log(`  console: ${r.consoleErrors.join(' | ')}`);
			if (r.pageErrors?.length) console.log(`  page:    ${r.pageErrors.join(' | ')}`);
			if (r.networkErrors?.length)
				console.log(
					`  network: ${r.networkErrors.map((e) => `${e.status ?? 'fail'} ${e.url}`).join(' | ')}`,
				);
			if (r.metrics?.hasHorizontalScroll)
				console.log(
					`  overflow: scroll=${r.metrics.scrollWidth}px client=${r.metrics.clientWidth}px`,
				);
		}
	}
	console.log(`\n${clean ? 'CLEAN' : 'ISSUES FOUND'} — screenshots in ${OUT_DIR}\n`);
	process.exit(clean ? 0 : 1);
}

main().catch((err) => {
	console.error('Snapshot failed:', err);
	process.exit(1);
});
