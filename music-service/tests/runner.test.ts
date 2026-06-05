import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract } from '../src/runner.js';

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
	it('reject 소스는 bad_source throw', async () => {
		await expect(extract('-x', deps())).rejects.toThrow(/bad_source/);
	});
	it('yt-dlp 비정상 종료 → throw', async () => {
		await expect(extract('https://yt/abc', deps({ spawn: fakeSpawn(1) as never }))).rejects.toThrow();
	});
});
