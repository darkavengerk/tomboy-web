import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSunoPlaylist } from './suno.js';

const JSON_PAGE = JSON.stringify({
	name: '내 믹스',
	num_total_results: 2,
	playlist_clips: [
		{ clip: { id: 'c1', title: 'Song One', audio_url: 'https://cdn1.suno.ai/c1.mp3' } },
		{ clip: { id: 'c2', title: 'Song Two', audio_url: 'https://cdn1.suno.ai/c2.mp3' } }
	]
});

function fetchStub(map: Record<string, { ok: boolean; status?: number; body: string }>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		const hit = Object.entries(map).find(([k]) => url.includes(k));
		if (!hit) return new Response('', { status: 404 });
		const { ok, status, body } = hit[1];
		return new Response(body, { status: status ?? (ok ? 200 : 500) });
	}) as typeof fetch;
}

test('JSON API: 클립을 트랙으로 매핑하고 label/total 채움', async () => {
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-abc123', {
		fetch: fetchStub({ '/api/playlist/PL-abc123/?page=1': { ok: true, body: JSON_PAGE }, '?page=2': { ok: true, body: JSON.stringify({ playlist_clips: [] }) } })
	});
	assert.equal(res.label, '내 믹스');
	assert.deepEqual(res.tracks, [
		{ url: 'https://cdn1.suno.ai/c1.mp3', title: 'Song One' },
		{ url: 'https://cdn1.suno.ai/c2.mp3', title: 'Song Two' }
	]);
	assert.equal(res.truncated, false);
});

test('비-재생목록 URL → bad_request', async () => {
	await assert.rejects(
		() => fetchSunoPlaylist('https://suno.com/song/xyz', { fetch: fetchStub({}) }),
		/bad_request/
	);
});

test('JSON non-OK → HTML 폴백(이스케이프 따옴표 포함)에서 추출', async () => {
	const html = `<script>self.__next_f.push([1,"{\\"title\\":\\"H Song\\",\\"audio_url\\":\\"https://cdn1.suno.ai/h1.mp3\\"}"])</script>`;
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-html', {
		fetch: fetchStub({ '/api/playlist/PL-html/?page=1': { ok: false, status: 401, body: '{}' }, 'suno.com/playlist/PL-html': { ok: true, body: html } })
	});
	assert.equal(res.tracks.length, 1);
	assert.equal(res.tracks[0].url, 'https://cdn1.suno.ai/h1.mp3');
	assert.equal(res.tracks[0].title, 'H Song');
});

test('maxPlaylist 초과 시 잘림', async () => {
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-abc123', {
		maxPlaylist: 1,
		fetch: fetchStub({ '/api/playlist/PL-abc123/?page=1': { ok: true, body: JSON_PAGE } })
	});
	assert.equal(res.tracks.length, 1);
	assert.equal(res.truncated, true);
});
