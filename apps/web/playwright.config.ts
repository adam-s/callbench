import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite for the evidence viewer. Runs against the dev server over the
 * COMMITTED fixture runs (fixtures/runs), so the suite is deterministic on a
 * fresh clone and touches no network beyond localhost — the same fixture rule
 * the unit suite lives by.
 *
 * Deliberately NOT part of the static checkout gate (`pnpm test`): a browser
 * suite is a dynamic script — bounded, diffable, run on demand:
 *   pnpm --filter @callbench/web e2e
 * Visual baselines live in e2e/__screenshots__ and are committed; they are
 * platform-suffixed, so regenerate with --update-snapshots on a new machine.
 */
export default defineConfig({
	testDir: './e2e',
	snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	// Bounded, always: a runaway suite is a bug even against localhost.
	timeout: 30_000,
	expect: {
		timeout: 5_000,
		toHaveScreenshot: {
			// Canvas waveforms render from frozen bytes, but antialiasing wobbles
			// by a pixel; a small ratio absorbs that without hiding real drift.
			maxDiffPixelRatio: 0.02,
		},
	},
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'pnpm dev --port 4173',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
});
