import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { mintToken } from '../src/auth.js';
import type { EnumerateOk } from '../src/runner.js';

function app(extractFn: (s: string) => Promise<{ url: string; title: string }>) {
	return buildServer({ sharedToken: 'tok', bridgeFilesUrl: 'http://b', extractFn });
}
const auth = { authorization: `Bearer ${mintToken('tok')}` };

describe('POST /extract', () => {
	it('401 without bearer', async () => {
		const res = await app(async () => ({ url: 'u', title: 't' })).inject({ method: 'POST', url: '/extract', payload: { source: 'x' } });
		expect(res.statusCode).toBe(401);
	});
	it('400 on missing source', async () => {
		const res = await app(async () => ({ url: 'u', title: 't' })).inject({ method: 'POST', url: '/extract', headers: auth, payload: {} });
		expect(res.statusCode).toBe(400);
	});
	it('200 with {url,title}', async () => {
		const fn = vi.fn(async () => ({ url: 'http://b/files/x/y.mp3', title: 'Y' }));
		const res = await app(fn).inject({ method: 'POST', url: '/extract', headers: auth, payload: { source: 'https://yt/a' } });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ url: 'http://b/files/x/y.mp3', title: 'Y' });
		expect(fn).toHaveBeenCalledWith('https://yt/a');
	});
	it('400 on bad_source, 504 on 타임아웃, 502 otherwise', async () => {
		const mk = (msg: string) => app(async () => { throw new Error(msg); }).inject({ method: 'POST', url: '/extract', headers: auth, payload: { source: 'x' } });
		expect((await mk('bad_source:leading_dash')).statusCode).toBe(400);
		expect((await mk('타임아웃')).statusCode).toBe(504);
		expect((await mk('too_large')).statusCode).toBe(413);
		expect((await mk('no_output')).statusCode).toBe(502);
	});
	it('413 too_large 응답 본문 error=too_large', async () => {
		const res = await app(async () => { throw new Error('too_large'); }).inject({ method: 'POST', url: '/extract', headers: auth, payload: { source: 'x' } });
		expect(res.statusCode).toBe(413);
		expect(res.json()).toEqual({ error: 'too_large' });
	});
});

function appEnum(enumerateFn: (s: string) => Promise<EnumerateOk>) {
	return buildServer({ sharedToken: 'tok', bridgeFilesUrl: 'http://b', enumerateFn });
}
const okEnum: EnumerateOk = { label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false };

describe('POST /enumerate', () => {
	it('401 without bearer', async () => {
		const res = await appEnum(async () => okEnum).inject({ method: 'POST', url: '/enumerate', payload: { source: 'x' } });
		expect(res.statusCode).toBe(401);
	});
	it('400 on missing source', async () => {
		const res = await appEnum(async () => okEnum).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: {} });
		expect(res.statusCode).toBe(400);
	});
	it('200 with enumerate result', async () => {
		const fn = vi.fn(async () => okEnum);
		const res = await appEnum(fn).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: { source: 'https://yt/p?list=PL' } });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual(okEnum);
		expect(fn).toHaveBeenCalledWith('https://yt/p?list=PL');
	});
	it('400 bad_source, 504 타임아웃, 502 otherwise', async () => {
		const mk = (msg: string) => appEnum(async () => { throw new Error(msg); }).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: { source: 'x' } });
		expect((await mk('bad_source:empty_playlist')).statusCode).toBe(400);
		expect((await mk('타임아웃')).statusCode).toBe(504);
		expect((await mk('boom')).statusCode).toBe(502);
	});
});
