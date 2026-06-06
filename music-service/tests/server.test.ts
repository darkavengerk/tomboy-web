import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { mintToken } from '../src/auth.js';

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
		expect((await mk('no_output')).statusCode).toBe(502);
	});
});
