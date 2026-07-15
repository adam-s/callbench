import { expect, test } from '@playwright/test';

/**
 * The viewer's journeys, driven over the committed fixture runs. The fixture
 * scenario (windshield-quote) has two runs: one all-PASS, one with a FAIL —
 * which makes the interesting states (worst-first ordering, the MIXED matrix
 * row, a failing finding with a cited span) real rather than mocked.
 */

const SCENARIO = 'windshield-quote';
const FAIL_RUN = '3cd98cde9bc1edb02970a32e406772da57b12684217cd37ab7f99d3a3f92b5a8';
const FAIL_FINDING = 'no-fabricated-recalibration';

test.describe('overview', () => {
	test('stat tiles and worst-first scenario table', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

		// Four tiles, with real figures from the fixtures.
		const tiles = page.locator('.tile');
		await expect(tiles).toHaveCount(4);
		await expect(tiles.filter({ hasText: 'Scenarios' })).toContainText('1');
		await expect(tiles.filter({ hasText: 'Runs' }).first()).toContainText('2');

		// The scenario row leads with its worst latest state.
		const row = page.locator('.table tbody tr').first();
		await expect(row).toContainText(SCENARIO);
		await expect(row.locator('.pill')).toHaveText('FAIL');
	});

	test('rail carries the map and the fence note', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.rail-link', { hasText: SCENARIO })).toBeVisible();
		await expect(page.locator('.rail-foot')).toContainText('Nothing here places a call');
	});
});

test.describe('scenario', () => {
	test('assertion matrix flags the mixed row', async ({ page }) => {
		await page.goto(`/tests/${SCENARIO}`);

		// The same assertion FAILs in one run and PASSes in the other — the
		// matrix must show both outcomes and flag the row as the finding.
		const mixedRow = page.locator('.matrix tbody tr.mixed');
		await expect(mixedRow).toHaveCount(1);
		await expect(mixedRow).toContainText(FAIL_FINDING);
		await expect(mixedRow).toContainText('MIXED');
		await expect(mixedRow.locator('.pill.FAIL')).toHaveCount(1);
		await expect(mixedRow.locator('.pill.PASS')).toHaveCount(1);
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

		// The call as one picture: waveform canvas + two ribbon lanes.
		await expect(page.locator('.wave canvas')).toBeVisible();
		await expect(page.locator('.ribbon .lane')).toHaveCount(2);

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
