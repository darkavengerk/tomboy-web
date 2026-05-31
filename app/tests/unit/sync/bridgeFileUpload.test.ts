import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	uploadBridgeFile,
	BridgeFileUploadError
} from '$lib/sync/bridgeFileUpload.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(),
	getTerminalBridgeToken: vi.fn(),
	bridgeToHttpBase: (b: string) =>
		b.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}));

import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	vi.mocked(getDefaultTerminalBridge).mockResolvedValue('https://b.test');
	vi.mocked(getTerminalBridgeToken).mockResolvedValue('tok');
	fetchMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('uploadBridgeFile', () => {
	it('throws bridge_not_configured when token missing', async () => {
		vi.mocked(getTerminalBridgeToken).mockResolvedValue('');
		await expect(uploadBridgeFile(new File(['x'], 'a.txt'))).rejects.toMatchObject({
			kind: 'bridge_not_configured'
		});
	});

	it('throws bridge_not_configured when URL missing', async () => {
		vi.mocked(getDefaultTerminalBridge).mockResolvedValue('');
		await expect(uploadBridgeFile(new File(['x'], 'a.txt'))).rejects.toMatchObject({
			kind: 'bridge_not_configured'
		});
	});

	it('throws empty_file for zero-byte file', async () => {
		await expect(uploadBridgeFile(new File([], 'empty.txt'))).rejects.toMatchObject({
			kind: 'empty_file'
		});
	});

	it('throws too_large when over 50 MiB', async () => {
		const big = new File([new Uint8Array(60 * 1024 * 1024)], 'big.bin');
		await expect(uploadBridgeFile(big)).rejects.toMatchObject({ kind: 'too_large' });
	});

	it('sends correct headers and returns metadata on 200', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					uuid: 'u-1',
					filename: 'doc.pdf',
					size: 5,
					url: 'https://b.test/files/u-1/doc.pdf'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		const file = new File(['hello'], '문서.pdf', { type: 'application/pdf' });
		const result = await uploadBridgeFile(file);
		expect(result).toEqual({
			uuid: 'u-1',
			filename: 'doc.pdf',
			size: 5,
			url: 'https://b.test/files/u-1/doc.pdf'
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://b.test/files');
		expect(init.method).toBe('POST');
		const h = init.headers as Record<string, string>;
		expect(h['Authorization']).toBe('Bearer tok');
		expect(h['Content-Type']).toBe('application/pdf');
		expect(h['X-Filename']).toBe(encodeURIComponent('문서.pdf'));
	});

	it('maps 401 → unauthorized', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
		await expect(
			uploadBridgeFile(new File(['x'], 'a.txt'))
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('maps 413 → too_large', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 413 }));
		await expect(
			uploadBridgeFile(new File(['x'], 'a.txt'))
		).rejects.toMatchObject({ kind: 'too_large' });
	});

	it('maps network error → network', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		await expect(
			uploadBridgeFile(new File(['x'], 'a.txt'))
		).rejects.toMatchObject({ kind: 'network' });
	});

	it('maps 500 → server', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
		await expect(
			uploadBridgeFile(new File(['x'], 'a.txt'))
		).rejects.toMatchObject({ kind: 'server' });
	});

	it('falls back to application/octet-stream when file.type missing', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ uuid: 'u', filename: 'a.bin', size: 1, url: 'https://b.test/x' }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		await uploadBridgeFile(new File(['x'], 'a.bin'));
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>)['Content-Type']).toBe(
			'application/octet-stream'
		);
	});

	it('exports BridgeFileUploadError class with kind', async () => {
		const err = new BridgeFileUploadError('network', 'msg');
		expect(err).toBeInstanceOf(Error);
		expect(err.kind).toBe('network');
	});
});
