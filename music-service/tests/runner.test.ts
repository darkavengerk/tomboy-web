import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract, enumerate } from '../src/runner.js';

// args에서 --paths <dir>를 찾아 그 디렉토리에 mp3를 떨구고 종료코드로 닫는 가짜 spawn.
function fakeSpawn(exitCode: number, title = 'Song') {
	return (_cmd: string, args: string[]) => {
		const i = args.indexOf('--paths');
		const dir = i >= 0 ? args[i + 1] : '.';
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => {
			if (exitCode === 0) writeFileSync(join(dir, `${title}.mp3`), 'ID3DATA');
			child.emit('close', exitCode);
		});
		return child as never;
	};
}

const deps = (over: Partial<Parameters<typeof extract>[1]> = {}) => ({
	spawn: fakeSpawn(0) as never,
	bridgeFilesUrl: 'http://bridge',
	sharedToken: 'tok',
	uploadFn: vi.fn(async () => 'http://bridge/files/uuid/Song.mp3'),
	...over
});

describe('extract', () => {
	it('mp3 추출→업로드→{url,title}', async () => {
		const d = deps();
		const out = await extract('https://yt/abc', d);
		expect(out).toEqual({ url: 'http://bridge/files/uuid/Song.mp3', title: 'Song' });
		expect(d.uploadFn).toHaveBeenCalledOnce();
	});
	it('yt-dlp 인자에 --embed-thumbnail 없음(WebKit 재생 실패 방지), --embed-metadata 유지', async () => {
		let captured: string[] = [];
		const recordingSpawn = (cmd: string, args: string[]) => {
			captured = args;
			return fakeSpawn(0)(cmd, args);
		};
		await extract('https://yt/abc', deps({ spawn: recordingSpawn as never }));
		expect(captured).not.toContain('--embed-thumbnail');
		expect(captured).toContain('--embed-metadata');
	});
	it('reject 소스는 bad_source throw', async () => {
		await expect(extract('-x', deps())).rejects.toThrow(/bad_source/);
	});
	it('yt-dlp 비정상 종료 → throw', async () => {
		await expect(extract('https://yt/abc', deps({ spawn: fakeSpawn(1) as never }))).rejects.toThrow();
	});
	it('mp3 없이 종료(0) → no_output throw', async () => {
		const noFileSpawn = (_cmd: string, _args: string[]) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			queueMicrotask(() => child.emit('close', 0));
			return child as never;
		};
		await expect(extract('https://yt/abc', deps({ spawn: noFileSpawn as never }))).rejects.toThrow('no_output');
	});
});

// stdout 으로 JSON 을 흘리고 종료코드로 닫는 가짜 spawn.
function fakeSpawnJson(exitCode: number, stdout: string) {
	return (_cmd: string, _args: string[]) => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => {
			if (exitCode === 0 && stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
			child.emit('close', exitCode);
		});
		return child as never;
	};
}
const PL_JSON = JSON.stringify({
	title: '가수A 믹스',
	entries: [
		{ id: 'aaa', title: 'Song A' },
		{ id: 'bbb', title: 'Song B' },
		{ id: 'ccc', title: 'Song C' }
	]
});

describe('enumerate', () => {
	it('정상 JSON → label + entries(id→watch url)', async () => {
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, PL_JSON) as never });
		expect(out.label).toBe('가수A 믹스');
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(false);
		expect(out.entries).toEqual([
			{ url: 'https://www.youtube.com/watch?v=aaa', title: 'Song A' },
			{ url: 'https://www.youtube.com/watch?v=bbb', title: 'Song B' },
			{ url: 'https://www.youtube.com/watch?v=ccc', title: 'Song C' }
		]);
	});
	it('maxPlaylist 상한으로 자르고 truncated=true', async () => {
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, PL_JSON) as never, maxPlaylist: 2 });
		expect(out.entries).toHaveLength(2);
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(true);
	});
	it('title 없으면 재생목록, url 폴백', async () => {
		const j = JSON.stringify({ entries: [{ url: 'https://www.youtube.com/watch?v=zzz' }] });
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, j) as never });
		expect(out.label).toBe('재생목록');
		expect(out.entries[0]).toEqual({ url: 'https://www.youtube.com/watch?v=zzz', title: 'zzz' });
	});
	it('0 엔트리 → bad_source:empty_playlist', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(0, JSON.stringify({ entries: [] })) as never }))
			.rejects.toThrow(/bad_source:empty_playlist/);
	});
	it('stdout 파싱 실패 → bad_source:enumerate_parse', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(0, 'not json') as never }))
			.rejects.toThrow(/bad_source:enumerate_parse/);
	});
	it('reject 소스 → bad_source', async () => {
		await expect(enumerate('-x', { spawn: fakeSpawnJson(0, PL_JSON) as never })).rejects.toThrow(/bad_source/);
	});
	it('검색어(비-URL) 소스 → bad_source:not_a_url', async () => {
		await expect(enumerate('PLabc123', { spawn: fakeSpawnJson(0, PL_JSON) as never })).rejects.toThrow(/bad_source:not_a_url/);
	});
	it('비정상 종료 → throw', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(1, '') as never })).rejects.toThrow();
	});
});
