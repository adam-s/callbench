import { expect, test } from '@playwright/test';

/**
 * Visual regression over the committed fixture runs. Baselines live in
 * e2e/__screenshots__ and are committed fixtures: a diff here means the UI
 * changed, and the diff image says exactly where. Regenerate deliberately with
 *   pnpm --filter @callbench/web e2e -- --update-snapshots
 * and review the new baselines like any other fixture change.
 *
 * Relative times ("2d ago") drift with the wall clock, so every spec masks
 * the elements that render them rather than pretending time holds still.
 */

const SCENARIO = 'windshield-quote';
const FAIL_RUN = '3cd98cde9bc1edb02970a32e406772da57b12684217cd37ab7f99d3a3f92b5a8';
const FAIL_FINDING = 'no-fabricated-recalibration';

// Stop the caret and any transitions so pixels settle.
const settle = async (page: import('@playwright/test').Page) => {
	await page.evaluate(() => document.fonts.ready);
	await page.addStyleTag({
		content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
	});
};

test('overview', async ({ page }) => {
	await page.goto('/');
	await settle(page);
	await expect(page).toHaveScreenshot('overview.png', {
		fullPage: true,
		mask: [page.locator('td.num.muted')], // "Nd ago" cells
	});
});

test('scenario', async ({ page }) => {
	await page.goto(`/tests/${SCENARIO}`);
	await settle(page);
	await expect(page).toHaveScreenshot('scenario.png', {
		fullPage: true,
		mask: [page.locator('td.num.muted')],
	});
});

test('run', async ({ page }) => {
	await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}`);
	await settle(page);
	// Wait for the waveform canvas to paint its frozen peaks.
	await expect(page.locator('.wave canvas')).toBeVisible();
	await expect(page).toHaveScreenshot('run.png', { fullPage: true });
});

test('finding', async ({ page }) => {
	await page.goto(`/tests/${SCENARIO}/${FAIL_RUN}/${FAIL_FINDING}`);
	await settle(page);
	await expect(page.locator('.wave canvas')).toBeVisible();
	// The deep link auto-plays its cited span; wait for the playhead to come to
	// rest at the span's end (t == duration == 0:34) so the pixels are
	// deterministic, not mid-flight. The wall-clock fallback guarantees the
	// clock arrives even where headless audio is silent.
	await expect(page.locator('.controls .time')).toHaveText('0:34 / 0:34', { timeout: 15_000 });
	await expect(page).toHaveScreenshot('finding.png', { fullPage: true });
});
