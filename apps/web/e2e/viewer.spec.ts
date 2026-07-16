import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The viewer's journeys, driven over the committed fixture runs. The reference
 * scenario (windshield-quote) carries one all-PASS and one with-FAIL run —
 * which makes the interesting states (worst-first ordering, the MIXED matrix
 * row, a failing finding with a cited span) real rather than mocked.
 *
 * Fixture COUNTS are read from the fixtures directory at test time, never
 * hardcoded: the fixture set grows every time a live take is published, and a
 * suite that pins last month's census fails on growth instead of on bugs
 * (which is exactly how this comment came to exist).
 */

const SCENARIO = 'windshield-quote';
const FAIL_RUN = '3cd98cde9bc1edb02970a32e406772da57b12684217cd37ab7f99d3a3f92b5a8';
const FAIL_FINDING = 'no-fabricated-recalibration';

const FIXTURES = fileURLToPath(new URL('../fixtures/runs', import.meta.url));
const scenarioDirs = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory());
const SCENARIO_COUNT = scenarioDirs.length;
const RUN_COUNT = scenarioDirs.reduce(
	(n, d) =>
		n +
		readdirSync(`${FIXTURES}/${d.name}`, { withFileTypes: true }).filter((r) => r.isDirectory())
			.length,
	0,
);

test.describe('overview', () => {
	test('stat tiles and worst-first scenario table', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

		// Four tiles, with real figures from the fixtures on disk.
		const tiles = page.locator('.tile');
		await expect(tiles).toHaveCount(4);
		await expect(tiles.filter({ hasText: 'Scenarios' })).toContainText(String(SCENARIO_COUNT));
		await expect(tiles.filter({ hasText: 'Runs' }).first()).toContainText(String(RUN_COUNT));

		// Worst-first ordering: reading down the table, severity never improves
		// then worsens again — FAIL rows first, then INCONCLUSIVE, then PASS.
		const SEVERITY: Record<string, number> = { FAIL: 0, INCONCLUSIVE: 1, PASS: 2 };
		const pills = await page.locator('.table tbody tr .pill').allTextContents();
		expect(pills.length).toBeGreaterThan(0);
		const ranks = pills.map((p) => SEVERITY[p.trim()] ?? 3);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
	});

	test('rail carries the map and the fence note', async ({ page }) => {
		await page.goto('/');
		await expect(
			page.locator('.rail-link').filter({ hasText: /^windshield-quote$/ }),
		).toBeVisible();
		await expect(page.locator('.rail-foot')).toContainText('Nothing here places a call');
	});
});

test.describe('scenario', () => {
	test('assertion matrix flags the mixed row', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}`);

		// The same assertion FAILs in one run and PASSes in another — the
		// matrix must show both outcomes and flag that row as the finding.
		// (Other assertions may also be mixed as the run set grows; this one
		// is the pinned reference case.)
		const mixedRow = page.locator('.matrix tbody tr.mixed', { hasText: FAIL_FINDING });
		await expect(mixedRow).toHaveCount(1);
		await expect(mixedRow).toContainText('MIXED');
		expect(await mixedRow.locator('.pill.FAIL').count()).toBeGreaterThanOrEqual(1);
		expect(await mixedRow.locator('.pill.PASS').count()).toBeGreaterThanOrEqual(1);
	});

	test('runs table links to run pages', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}`);
		await page.locator('.table .row-link', { hasText: FAIL_RUN.slice(0, 12) }).click();
		await expect(page).toHaveURL(`/tests/${SCENARIO}/${FAIL_RUN}`);
		await expect(page.getByRole('heading', { name: FAIL_RUN.slice(0, 12) })).toBeVisible();
	});

	test('unknown scenario is a 404, not a blank page', async ({ page }) => {
		const response = await page.goto('/tests/no-such-scenario');
		expect(response?.status()).toBe(404);
	});
});

test.describe('run', () => {
	test('evidence card, findings, and transcript render together', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}`);

		// The call as one picture: waveform canvas + two ribbon tracks sharing
		// its axis (.lane was the pre-legend layout; .track since the rebuild).
		await expect(page.locator('.wave canvas')).toBeVisible();
		await expect(page.locator('.ribbon .track')).toHaveCount(2);

		// Findings carry outcome + provenance, and trace to the transcript.
		const failFinding = page.locator('.findings li', { hasText: FAIL_FINDING });
		await expect(failFinding.locator('.pill.FAIL')).toBeVisible();
		await expect(failFinding.locator('.chip')).toHaveText('code');

		// The transcript is verbatim turns with speakers and timings.
		const turns = page.locator('.transcript .turn');
		await expect(turns.first()).toContainText('BENCH');
		expect(await turns.count()).toBeGreaterThan(4);
	});

	test('hearing a span moves the one clock', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}`);
		const time = page.locator('.controls .time');
		// The frozen duration appearing proves hydration finished and the
		// transport loaded — before that, the ▶ has no listener to receive the
		// click (SSR markup renders first).
		await expect(time).toContainText('/ 0:34');
		await expect(time).toContainText('0:00 /');

		// ▶ on a finding plays its span. Even where headless audio is silent,
		// the transport's wall-clock fallback must advance the playhead — that
		// fallback existing is the point of the assertion.
		await page.locator('.findings li', { hasText: FAIL_FINDING }).locator('.btn-icon').click();
		await expect(time).not.toContainText('0:00 /', { timeout: 3_000 });
	});

	test('audio endpoint serves frozen bytes with immutable caching', async ({ request }) => {
		const res = await request.get(`/tests/${SCENARIO}/${FAIL_RUN}/audio`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toBe('audio/wav');
		expect(res.headers()['cache-control']).toContain('immutable');
	});
});

test.describe('finding deep link', () => {
	test('lands on the cited moment', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}/${FAIL_FINDING}`);
		await expect(page.getByRole('heading', { name: FAIL_FINDING })).toBeVisible();
		await expect(page.locator('.page-head .pill.FAIL')).toBeVisible();

		// The cited turn is lit; the rest of the transcript is dimmed around it.
		await expect(page.locator('.turn.cited')).toHaveCount(1);
		await expect(page.locator('.turn.cited')).toContainText('camera recalibration');
		await expect(page.getByRole('button', { name: 'Hear this moment' })).toBeVisible();
	});

	test('unknown finding is a 404', async ({ page }) => {
		const response = await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}/no-such-assertion`);
		expect(response?.status()).toBe(404);
	});
});

test.describe('the fence', () => {
	// The dial fence is structural: no surface offers a control that places,
	// re-places, or re-runs a call. The play vocabulary belongs to playback of
	// frozen recordings only. If this test ever fails, that is not a UI nit —
	// it is the single highest-severity regression the app can have.
	const DIAL_WORDS = /\b(dial|re-?dial|call now|place call|start call|re-?run|run test)\b/i;

	for (const path of [
		'/',
		`/tests/${SCENARIO}`,
		`/tests/${SCENARIO}/${FAIL_RUN}`,
		`/tests/${SCENARIO}/${FAIL_RUN}/${FAIL_FINDING}`,
	]) {
		test(`no dial affordance on ${path}`, async ({ page }) => {
			await page.goto(path);
			const controls = page.locator('button, a[role="button"], input[type="submit"]');
			for (const text of await controls.allTextContents()) {
				expect(text).not.toMatch(DIAL_WORDS);
			}
			for (const label of await controls.evaluateAll((els) =>
				els.map((el) => el.getAttribute('aria-label') ?? ''),
			)) {
				expect(label).not.toMatch(DIAL_WORDS);
			}
		});
	}
});
