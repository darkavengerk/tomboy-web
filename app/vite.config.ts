import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./tests/setup.ts'],
		server: {
			deps: {
				// Svelte 5 컴포넌트 테스트를 위해 browser 조건으로 해석
				inline: [/svelte/]
			}
		}
	},
	resolve: {
		conditions: ['browser']
	}
});
