import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		// apps/web server-side logic is plain Node (fs + workspace packages), so it
		// runs under this same node environment. Its tested modules import shared
		// types by RELATIVE path, never `$lib/*`, so no SvelteKit alias is needed
		// here; component/DOM tests, when they arrive, get their own jsdom project.
		include: ['packages/**/*.test.ts', 'scripts/**/*.test.mjs', 'apps/web/src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**'],
	},
});
