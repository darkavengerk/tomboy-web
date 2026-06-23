/**
 * Retry-policy audit for the Dropbox client's `withRetry` wrapper.
 *
 * Root cause this guards against: `content.dropboxapi.com` CORS *preflight*
 * (OPTIONS) requests intermittently return 400, which the browser surfaces to
 * JS as a status-less `TypeError` ("NetworkError when attempting to fetch
 * resource" / "Failed to fetch"). The old policy only retried HTTP 429, so a
 * single transient preflight failure aborted the whole sync (download / upload
 * commit / even the lightweight preview manifest download). The user had to
 * manually re-click — i.e. be the retry loop the code lacked.
 *
 * New policy (`isTransient`):
 *   - 429 (rate limit)            → retry (honoring Retry-After)
 *   - 5xx (server)                → retry
 *   - NO http status (fetch TypeError = transport / CORS-preflight failure)
 *                                 → retry on a fresh connection
 *   - any other status (4xx)      → deterministic, do NOT retry
 *   - non-fetch Error w/o status  → NOT retried (preserves fast-fail; the
 *                                    commit-safety tests inject `new Error`)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const filesDownloadMock = vi.fn();
const filesUploadMock = vi.fn(async () => ({ result: {} }));

vi.mock('dropbox', () => {
	class DropboxAuth {
		setAccessToken() {}
		setRefreshToken() {}
		setAccessTokenExpiresAt() {}
		async checkAndRefreshAccessToken() {}
		getAccessToken() {
			return 'fake';
		}
		getAccessTokenExpiresAt() {
			return null;
		}
	}
	class Dropbox {
		filesDownload = filesDownloadMock;
		filesUpload = filesUploadMock;
	}
	return { Dropbox, DropboxAuth };
});

import { downloadServerManifest, isTransient, setNotesPath } from '$lib/sync/dropboxClient.js';

const MANIFEST_XML =
	`<?xml version="1.0" encoding="utf-8"?>\n` +
	`<sync revision="3" server-id="SID">\n  <note id="g1" rev="2" />\n</sync>`;

function authenticate() {
	localStorage.setItem('tomboy-dropbox-access-token', 'fake-token');
	localStorage.setItem('tomboy-dropbox-refresh-token', 'fake-refresh');
}

function httpError(status: number, message = `status ${status}`): Error {
	return Object.assign(new Error(message), { status });
}

beforeEach(() => {
	filesDownloadMock.mockReset();
	localStorage.clear();
	authenticate();
	setNotesPath('');
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Pure classification ───────────────────────────────────────────────────────

describe('isTransient — retry classification', () => {
	it('retries rate-limit 429', () => {
		expect(isTransient({ status: 429 })).toBe(true);
	});

	it('retries 5xx server errors', () => {
		expect(isTransient({ status: 500 })).toBe(true);
		expect(isTransient({ status: 503 })).toBe(true);
	});

	it('retries a status-less fetch TypeError (CORS-preflight / network failure)', () => {
		expect(isTransient(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true);
		expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
	});

	it('does NOT retry deterministic 4xx', () => {
		for (const status of [400, 401, 403, 404, 409]) {
			expect(isTransient({ status }), `status ${status}`).toBe(false);
		}
	});

	it('does NOT retry a non-fetch Error lacking a status (preserves fast-fail)', () => {
		expect(isTransient(new Error('network'))).toBe(false);
	});
});

// ─── Retry loop behavior (via downloadServerManifest, the lightest user path) ────

describe('withRetry via downloadServerManifest', () => {
	it('retries a CORS-preflight TypeError then succeeds', async () => {
		vi.useFakeTimers();
		let calls = 0;
		filesDownloadMock.mockImplementation(async () => {
			calls++;
			if (calls <= 2) throw new TypeError('NetworkError when attempting to fetch resource');
			return { result: { fileBlob: new Blob([MANIFEST_XML]) } };
		});

		const p = downloadServerManifest();
		await vi.advanceTimersByTimeAsync(60_000);
		const manifest = await p;

		expect(manifest).not.toBeNull();
		expect(manifest!.revision).toBe(3);
		expect(filesDownloadMock).toHaveBeenCalledTimes(3); // 2 fail + 1 success
	});

	it('gives up after MAX_RETRIES on a persistent network failure', async () => {
		vi.useFakeTimers();
		filesDownloadMock.mockImplementation(async () => {
			throw new TypeError('Failed to fetch');
		});

		const p = downloadServerManifest();
		const expectation = expect(p).rejects.toThrow(TypeError);
		await vi.advanceTimersByTimeAsync(120_000);
		await expectation;

		expect(filesDownloadMock).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
	});

	it('does NOT retry a deterministic HTTP 403 (no wasted attempts)', async () => {
		filesDownloadMock.mockImplementation(async () => {
			throw httpError(403, 'forbidden');
		});

		await expect(downloadServerManifest()).rejects.toThrow('forbidden');
		expect(filesDownloadMock).toHaveBeenCalledTimes(1);
	});

	it('409 path_not_found returns null without retry (fresh-server path intact)', async () => {
		filesDownloadMock.mockImplementation(async () => {
			throw httpError(409, 'path_not_found');
		});

		const manifest = await downloadServerManifest();
		expect(manifest).toBeNull();
		expect(filesDownloadMock).toHaveBeenCalledTimes(1);
	});
});
