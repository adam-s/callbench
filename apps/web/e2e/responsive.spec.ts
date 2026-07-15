import { expect, test } from '@playwright/test';

/**
 * Rendering contract across the machines this is actually read on: a MacBook
 * Pro (the maintainer's), a tablet, and a phone. Two invariants per route ×
 * viewport:
 *
 *  1. NO horizontal page overflow — wide content (matrix, transcript, wave)
 *     scrolls inside its own container, never the body.
 *  2. The load-bearing surface for that route is visible and usable.
 *
 * Plus the document metadata every route must carry: a specific <title> and a
 * meta description.
 */

const SCENARIO = 'windshield-quote';
const FAIL_RUN = '3cd98cde9bc1edb02970a32e406772da57b12684217cd37ab7f99d3a3f92b5a8';
const FAIL_FINDING = 'no-fabricated-recalibration';

const VIEWPORTS = [
	{ name: 'macbook-pro', width: 1512, height: 982 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'mobile', width: 375, height: 812 },
] as const;

const ROUTES = [
	{ path: '/', probe: '.tiles .tile', title: /^Overview · callbench$/ },
	{ path: `/tests/${SCENARIO}`, probe: '.matrix', title: new RegExp(`^${SCENARIO} · callbench$`) },
	{
		path: `/tests/${SCENARIO}/${FAIL_RUN}`,
		probe: '.wave canvas',
		title: new RegExp(`^${FAIL_RUN.slice(0, 12)} · ${SCENARIO} · callbench$`),
	},
	{
		path: `/tests/${SCENARIO}/${FAIL_RUN}/${FAIL_FINDING}`,
		probe: '.turn.cited',
		title: new RegExp(`^${FAIL_FINDING} · ${FAIL_RUN.slice(0, 12)} · callbench$`),
	},
] as const;

for (const vp of VIEWPORTS) {
	test.describe(`${vp.name} (${vp.width}x${vp.height})`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		for (const route of ROUTES) {
			test(`${route.path} renders without page overflow`, async ({ page }) => {
				await page.goto(route.path);
				await expect(page.locator(route.probe).first()).toBeVisible();

				// The body never scrolls horizontally; overflow belongs to .table-wrap.
				const overflow = await page.evaluate(() => {
					const doc = document.documentElement;
					return Math.max(document.body.scrollWidth, doc.scrollWidth) - doc.clientWidth;
				});
				expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);

				await expect(page).toHaveTitle(route.title);
				const description = page.locator('meta[name="description"]');
				await expect(description).toHaveAttribute('content', /callbench|Scenario|Run|Finding/);
			});
		}
	});
}
