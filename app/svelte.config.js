import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			// Node 20 LTS. Bump when Vercel drops 20.x support.
			runtime: 'nodejs20.x'
		}),
		prerender: {
			// Dead links in prerendered pages warn but don't fail the build.
			handleHttpError: 'warn',
			// Dynamic routes (/note/[id], /admin/notes/[guid], etc.) aren't
			// statically crawlable — let the SPA handle them at runtime instead
			// of aborting the build.
			handleUnseenRoutes: 'ignore'
		}
	}
};

export default config;
