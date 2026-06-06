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
		},
		version: {
			// 새 배포 감지: 1분마다 /_app/version.json 을 폴링한다. 버전이
			// 바뀌면 SvelteKit 의 `updated` 스토어가 true 가 되고, 그 뒤
			// client-side 내비게이션은 자동으로 풀 페이지 로드로 전환되어
			// 새 빌드의 해시 청크를 받아온다. (+layout.svelte 에서 토스트로 안내)
			pollInterval: 60_000
		}
	}
};

export default config;
