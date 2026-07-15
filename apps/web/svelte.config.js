import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * SvelteKit config. adapter-node because everything runs server-side: the route
 * reads the frozen artifact off disk in a server load, verifies its hash, and
 * refuses on mismatch (ui.md). The browser renders what the server hands it and
 * never holds a call.
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
	},
};

export default config;
