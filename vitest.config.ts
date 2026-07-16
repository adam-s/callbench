import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because two worlds run under one gate:
 *   - `node`: everything server-side and pure — the packages, the scripts, and
 *     the web app's server logic. Plain node, no DOM, no Svelte compiler.
 *   - `dom`: the browser-side audio engine (a `.svelte.ts` module using Svelte 5
 *     runes). It needs the Svelte plugin to compile `$state`/`$effect` and a DOM
 *     environment; its tests are named `*.dom.test.ts` and are excluded from the
 *     node project so they never run without the compiler.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					// `scripts/**` matches BOTH extensions on purpose. It was
					// `scripts/**/*.test.mjs` only, so a `.test.ts` under scripts/ was
					// invisible to the runner — a whole test file for the fact set's
					// safety gate sat there executing zero times, and the mutations it
					// was written to catch all "survived". A glob that silently skips
					// a test file is worse than a missing test: the file looks like
					// coverage.
					include: [
						'packages/**/*.test.ts',
						'scripts/**/*.test.mjs',
						'scripts/**/*.test.ts',
						'apps/web/src/**/*.test.ts',
					],
					exclude: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**', '**/*.dom.test.ts'],
				},
			},
			{
				plugins: [svelte()],
				test: {
					name: 'dom',
					environment: 'jsdom',
					include: ['apps/web/src/**/*.dom.test.ts'],
					exclude: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**'],
				},
			},
		],
	},
});
