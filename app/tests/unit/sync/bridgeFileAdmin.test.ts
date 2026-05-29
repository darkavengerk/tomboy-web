import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	listBridgeFiles,
	deleteBridgeFile,
	type BridgeFileMeta
} from '$lib/sync/bridgeFileAdmin.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(() => Promise.resolve('https://b.test')),
	getTerminalBridgeToken: vi.fn(() => Promise.resolve('tok')),
	bridgeToHttpBase: (b: string) => b
}));

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listBridgeFiles', () => {
	it('returns parsed meta array on 200', async () => {
		const items: BridgeFileMeta[] = [
			{ uuid: 'u', filename: 'a.pdf', size: 1, mtime: '2026-05-29T00:00:00Z' }
		];
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify(items), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		const result = await listBridgeFiles();
		expect(result).toEqual(items);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://b.test/files');
		expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
	});

	it('throws on non-200', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
		await expect(listBridgeFiles()).rejects.toThrow();
	});
});

describe('deleteBridgeFile', () => {
	it('sends DELETE with bearer', async () => {
		fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
		await deleteBridgeFile('u-1');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://b.test/files/u-1');
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
	});

	it('throws on non-200', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
		await expect(deleteBridgeFile('u-1')).rejects.toThrow();
	});
});
