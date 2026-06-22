import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract, enumerate, extractChapters } from '../src/runner.js';

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
	it('max-filesize 초과(stdout 마커 + mp3 없이 종료 0) → too_large throw', async () => {
		// yt-dlp 는 --max-filesize 초과 시 stdout 에 "larger than max-filesize ... Aborting."
		// 를 찍고 종료코드 0 으로 끝낸다(파일 미생성). no_output 으로 뭉뚱그리지 말고 too_large 로.
		const overSpawn = (_cmd: string, _args: string[]) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			queueMicrotask(() => {
				child.stdout.emit('data', Buffer.from('[download] File is larger than max-filesize (51308665 bytes > 41943040 bytes). Aborting.\n', 'utf8'));
				child.emit('close', 0);
			});
			return child as never;
		};
		await expect(extract('https://yt/abc', deps({ spawn: overSpawn as never }))).rejects.toThrow('too_large');
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

// 챕터 분할 가짜 spawn: 두 번째 `--paths chapter:<dir>` 에 챕터 mp3 들을, 첫 `--paths <dir>` 에
// 풀 mp3 를 떨군다. chapterTitles 비면 챕터 디렉토리를 만들지 않아(챕터 없는 영상) 폴백 경로 검증.
function fakeChapterSpawn(opts: { full: string; chapters: string[]; exit?: number; ffmpegExit?: number }) {
	return (_cmd: string, args: string[]) => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		// addXingHeader 의 ffmpeg 재먹싱 호출: -i <in> ... <out>. 입력을 출력으로 복사해
		// 성공을 흉내낸다(ffmpegExit 로 실패도 시뮬레이트). yt-dlp 와 구분.
		if (args.includes('-write_xing')) {
			const ffmpegExit = opts.ffmpegExit ?? 0;
			queueMicrotask(() => {
				if (ffmpegExit === 0) {
					const inPath = args[args.indexOf('-i') + 1];
					const out = args[args.length - 1];
					try { writeFileSync(out, readFileSync(inPath)); } catch { /* noop */ }
				}
				child.emit('close', ffmpegExit);
			});
			return child as never;
		}
		const paths: string[] = [];
		args.forEach((a, i) => { if (a === '--paths') paths.push(args[i + 1]); });
		const fullDir = paths.find((p) => !p.startsWith('chapter:')) ?? '.';
		const chapDir = (paths.find((p) => p.startsWith('chapter:')) ?? 'chapter:.').slice('chapter:'.length);
		queueMicrotask(() => {
			const exit = opts.exit ?? 0;
			if (exit === 0) {
				writeFileSync(join(fullDir, `${opts.full}.mp3`), 'FULL');
				if (opts.chapters.length > 0) {
					mkdirSync(chapDir, { recursive: true });
					opts.chapters.forEach((t) => writeFileSync(join(chapDir, `${t}.mp3`), 'CH'));
				}
			}
			child.emit('close', exit);
		});
		return child as never;
	};
}

const chDeps = (over: Partial<Parameters<typeof extractChapters>[1]> = {}) => ({
	spawn: fakeChapterSpawn({ full: '풀 영상', chapters: ['001 인트로', '002 1악장', '003 2악장'] }) as never,
	bridgeFilesUrl: 'http://bridge',
	sharedToken: 'tok',
	uploadFn: vi.fn(async (_b: Buffer, fn: string) => `http://bridge/files/uuid/${encodeURIComponent(fn)}`),
	...over
});

describe('extractChapters', () => {
	it('챕터별 mp3 → tracks(순서/제목) + label=풀 제목', async () => {
		const d = chDeps();
		const out = await extractChapters('https://yt/abc', d);
		expect(out.label).toBe('풀 영상');
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(false);
		expect(out.tracks.map((t) => t.title)).toEqual(['001 인트로', '002 1악장', '003 2악장']);
		expect(out.tracks).toHaveLength(3);
		expect(d.uploadFn).toHaveBeenCalledTimes(3);
	});

	it('--split-chapters 인자 포함, chapter: 경로 라우팅', async () => {
		let captured: string[] = [];
		// addXingHeader 의 ffmpeg 호출이 캡처를 덮지 않도록 yt-dlp 호출만 잡는다.
		const rec = (cmd: string, args: string[]) => { if (args.includes('--split-chapters')) captured = args; return fakeChapterSpawn({ full: 'F', chapters: ['001 A'] })(cmd, args); };
		await extractChapters('https://yt/abc', chDeps({ spawn: rec as never }));
		expect(captured).toContain('--split-chapters');
		expect(captured.some((a) => a.startsWith('chapter:'))).toBe(true);
		// 풀 다운로드 상한은 넉넉한 기본 1G.
		const mi = captured.indexOf('--max-filesize');
		expect(captured[mi + 1]).toBe('1G');
	});

	it('챕터 없는 영상 → 풀 곡 한 개로 폴백', async () => {
		const d = chDeps({ spawn: fakeChapterSpawn({ full: '단일곡', chapters: [] }) as never });
		const out = await extractChapters('https://yt/abc', d);
		expect(out.total).toBe(1);
		expect(out.tracks).toHaveLength(1);
		expect(out.tracks[0].title).toBe('단일곡');
		expect(out.label).toBe('단일곡');
	});

	it('maxChapters 상한으로 자르고 truncated=true', async () => {
		const d = chDeps({
			spawn: fakeChapterSpawn({ full: 'F', chapters: ['001 A', '002 B', '003 C'] }) as never,
			maxChapters: 2
		});
		const out = await extractChapters('https://yt/abc', d);
		expect(out.tracks).toHaveLength(2);
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(true);
	});

	it('각 챕터 세그먼트에 무손실 Xing 헤더 재먹싱(ffmpeg -c copy -write_xing)', async () => {
		const calls: string[][] = [];
		const rec = (cmd: string, args: string[]) => {
			calls.push(args);
			return fakeChapterSpawn({ full: 'F', chapters: ['001 A', '002 B'] })(cmd, args);
		};
		const out = await extractChapters('https://yt/abc', chDeps({ spawn: rec as never }));
		const ff = calls.filter((a) => a.includes('-write_xing'));
		expect(ff).toHaveLength(2); // 챕터 개수만큼
		// 무손실: -c copy (재인코딩 아님)
		ff.forEach((a) => {
			const ci = a.indexOf('-c');
			expect(a[ci + 1]).toBe('copy');
		});
		expect(out.tracks).toHaveLength(2);
	});

	it('풀 곡 폴백(챕터 없음)은 Xing 재먹싱을 하지 않는다', async () => {
		const calls: string[][] = [];
		const rec = (cmd: string, args: string[]) => {
			calls.push(args);
			return fakeChapterSpawn({ full: '단일곡', chapters: [] })(cmd, args);
		};
		await extractChapters('https://yt/abc', chDeps({ spawn: rec as never }));
		expect(calls.some((a) => a.includes('-write_xing'))).toBe(false);
	});

	it('ffmpeg 재먹싱 실패해도 원본으로 업로드(추출 안 깨짐)', async () => {
		const d = chDeps({
			spawn: fakeChapterSpawn({ full: 'F', chapters: ['001 A'], ffmpegExit: 1 }) as never
		});
		const out = await extractChapters('https://yt/abc', d);
		expect(out.tracks).toHaveLength(1);
		expect(d.uploadFn).toHaveBeenCalledTimes(1);
	});

	it('검색어(비-URL) → bad_source:not_a_url', async () => {
		await expect(extractChapters('lofi mix', chDeps())).rejects.toThrow(/bad_source:not_a_url/);
	});

	it('reject 소스 → bad_source', async () => {
		await expect(extractChapters('-x', chDeps())).rejects.toThrow(/bad_source/);
	});

	it('아무 파일 없이 종료 → no_output', async () => {
		const noFile = (_cmd: string, _args: string[]) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			queueMicrotask(() => child.emit('close', 0));
			return child as never;
		};
		await expect(extractChapters('https://yt/abc', chDeps({ spawn: noFile as never }))).rejects.toThrow('no_output');
	});

	it('max-filesize 초과(stdout 마커) → too_large', async () => {
		const over = (_cmd: string, _args: string[]) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			queueMicrotask(() => {
				child.stdout.emit('data', Buffer.from('File is larger than max-filesize (2000000000 bytes > 1073741824 bytes). Aborting.\n', 'utf8'));
				child.emit('close', 0);
			});
			return child as never;
		};
		await expect(extractChapters('https://yt/abc', chDeps({ spawn: over as never }))).rejects.toThrow('too_large');
	});
});
