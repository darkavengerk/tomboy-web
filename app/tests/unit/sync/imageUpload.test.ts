import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('$env/static/public', () => ({
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
}));

const filesUploadMock = vi.fn();
const createSharedLinkMock = vi.fn();
const listSharedLinksMock = vi.fn();

vi.mock('dropbox', () => {
	class DropboxAuth {
		setAccessToken() {}
		setRefreshToken() {}
	}
	class Dropbox {
		filesUpload = filesUploadMock;
		sharingCreateSharedLinkWithSettings = createSharedLinkMock;
		sharingListSharedLinks = listSharedLinksMock;
	}
	return { Dropbox, DropboxAuth };
});

import {
	toDirectImageUrl,
	uploadImageToDropbox
} from '$lib/sync/imageUpload.js';
import { getImagesPath, setImagesPath } from '$lib/sync/dropboxClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authenticate() {
	localStorage.setItem('tomboy-dropbox-access-token', 'fake-token');
	localStorage.setItem('tomboy-dropbox-refresh-token', 'fake-refresh');
}

function fakeFile(name: string, type: string, data = 'content') {
	return new File([data], name, { type });
}

beforeEach(() => {
	filesUploadMock.mockReset();
	createSharedLinkMock.mockReset();
	listSharedLinksMock.mockReset();
	localStorage.clear();
});

// ─── toDirectImageUrl ────────────────────────────────────────────────────────

describe('toDirectImageUrl', () => {
	it('converts legacy ?dl=0 shared link to ?raw=1', () => {
		const out = toDirectImageUrl('https://www.dropbox.com/s/abc/cat.png?dl=0');
		expect(out).toContain('raw=1');
		expect(out).not.toContain('dl=0');
	});

	it('preserves rlkey on modern SCL link while flipping dl=0 → raw=1', () => {
		const out = toDirectImageUrl(
			'https://www.dropbox.com/scl/fi/xxx/cat.png?rlkey=yyy&dl=0'
		);
		expect(out).toContain('rlkey=yyy');
		expect(out).toContain('raw=1');
		expect(out).not.toContain('dl=0');
	});

	it('leaves non-Dropbox URLs unchanged', () => {
		expect(toDirectImageUrl('https://example.com/cat.png')).toBe(
			'https://example.com/cat.png'
		);
	});

	it('leaves dl.dropboxusercontent.com direct links alone (already serves raw)', () => {
		// Already a direct host; we don't need to append raw=1 but we also
		// don't want to break it.
		const result = toDirectImageUrl('https://dl.dropboxusercontent.com/s/abc/cat.png');
		// Either unchanged or still serves the image — just assert it's
		// still pointing at the right path.
		expect(result).toContain('/s/abc/cat.png');
	});

	it('returns input verbatim on unparseable URL', () => {
		expect(toDirectImageUrl('not a url at all')).toBe('not a url at all');
	});
});

// ─── uploadImageToDropbox ────────────────────────────────────────────────────

describe('uploadImageToDropbox — auth', () => {
	it('throws when not authenticated', async () => {
		await expect(
			uploadImageToDropbox(fakeFile('a.png', 'image/png'))
		).rejects.toThrow(/연결|auth/i);
	});
});

describe('uploadImageToDropbox — happy path', () => {
	beforeEach(() => {
		authenticate();
		filesUploadMock.mockResolvedValue({ result: {} });
		createSharedLinkMock.mockResolvedValue({
			result: { url: 'https://www.dropbox.com/s/xyz/a.png?dl=0' }
		});
	});

	it('uploads to the default images path (/tomboy-image) with UUID filename', async () => {
		await uploadImageToDropbox(fakeFile('a.png', 'image/png'));

		expect(filesUploadMock).toHaveBeenCalledTimes(1);
		const arg = filesUploadMock.mock.calls[0][0];
		expect(arg.path).toMatch(/^\/tomboy-image\/[a-f0-9-]{8,}\.png$/i);
	});

	it('respects a configured images path', async () => {
		setImagesPath('/my-custom-images');
		await uploadImageToDropbox(fakeFile('a.png', 'image/png'));

		const arg = filesUploadMock.mock.calls[0][0];
		expect(arg.path).toMatch(/^\/my-custom-images\/[a-f0-9-]{8,}\.png$/i);
	});

	it('preserves the original file extension in the uploaded path', async () => {
		await uploadImageToDropbox(fakeFile('photo.jpg', 'image/jpeg'));
		const arg = filesUploadMock.mock.calls[0][0];
		expect(arg.path).toMatch(/\.jpg$/);
	});

	it('falls back to MIME type when filename has no extension', async () => {
		await uploadImageToDropbox(fakeFile('clipboard-paste', 'image/png'));
		const arg = filesUploadMock.mock.calls[0][0];
		expect(arg.path).toMatch(/\.png$/);
	});

	it('creates a public shared link for the uploaded file', async () => {
		await uploadImageToDropbox(fakeFile('a.png', 'image/png'));
		expect(createSharedLinkMock).toHaveBeenCalledTimes(1);
		const linkArg = createSharedLinkMock.mock.calls[0][0];
		// The shared link must be on the same path as the upload.
		const uploadPath = filesUploadMock.mock.calls[0][0].path;
		expect(linkArg.path).toBe(uploadPath);
	});

	it('returns a direct image URL (raw=1 form)', async () => {
		const url = await uploadImageToDropbox(fakeFile('a.png', 'image/png'));
		expect(url).toContain('raw=1');
		expect(url).not.toContain('dl=0');
	});
});

describe('uploadImageToDropbox — shared link already exists', () => {
	beforeEach(() => {
		authenticate();
		filesUploadMock.mockResolvedValue({ result: {} });
	});

	it('recovers the existing link from the error metadata', async () => {
		createSharedLinkMock.mockRejectedValue({
			error: {
				error: {
					'.tag': 'shared_link_already_exists',
					shared_link_already_exists: {
						metadata: { url: 'https://www.dropbox.com/s/abc/a.png?dl=0' }
					}
				}
			}
		});
		const url = await uploadImageToDropbox(fakeFile('a.png', 'image/png'));
		expect(url).toContain('raw=1');
	});

	it('lists shared links as a last-resort recovery when metadata is missing', async () => {
		createSharedLinkMock.mockRejectedValue({
			error: { error: { '.tag': 'shared_link_already_exists' } }
		});
		listSharedLinksMock.mockResolvedValue({
			result: {
				links: [{ url: 'https://www.dropbox.com/s/found/a.png?dl=0' }]
			}
		});
		const url = await uploadImageToDropbox(fakeFile('a.png', 'image/png'));
		expect(url).toContain('raw=1');
		expect(listSharedLinksMock).toHaveBeenCalledTimes(1);
	});
});

describe('uploadImageToDropbox — other failures', () => {
	beforeEach(() => {
		authenticate();
	});

	it('propagates upload errors', async () => {
		filesUploadMock.mockRejectedValue(new Error('network down'));
		await expect(
			uploadImageToDropbox(fakeFile('a.png', 'image/png'))
		).rejects.toThrow(/network down/);
	});
});

// ─── imagesPath helper ────────────────────────────────────────────────────────

describe('getImagesPath default', () => {
	it('defaults to /tomboy-image when nothing is stored', () => {
		expect(getImagesPath()).toBe('/tomboy-image');
	});

	it('returns the user-configured path when set', () => {
		setImagesPath('/custom-folder');
		expect(getImagesPath()).toBe('/custom-folder');
	});

	it('normalizes paths (adds leading slash, strips trailing slash)', () => {
		setImagesPath('custom/');
		expect(getImagesPath()).toBe('/custom');
	});
});
