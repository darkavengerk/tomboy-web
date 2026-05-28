import type { ImageFetcher } from './types.js';
import { getClient } from '../../sync/dropboxClient.js';

interface DropboxSdkClient {
	sharingGetSharedLinkFile: (arg: { url: string }) => Promise<{
		result: { fileBlob?: Blob };
	}>;
}

function isDropboxUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (
			u.hostname === 'dropbox.com' ||
			u.hostname.endsWith('.dropbox.com') ||
			u.hostname.endsWith('.dropboxusercontent.com')
		);
	} catch {
		return false;
	}
}

/**
 * Fetches Dropbox shared-link bytes via `sharingGetSharedLinkFile`, which
 * routes through `api.dropboxapi.com` / `content.dropboxapi.com` —
 * unlike `www.dropbox.com`, those endpoints return CORS headers so
 * `fetch()`-via-SDK works cross-origin.
 *
 * Requires the Dropbox client to be authenticated to the account that
 * owns the link.
 */
export const dropboxFetcher: ImageFetcher = {
	name: 'dropbox',
	matches: isDropboxUrl,
	async fetch(url: string): Promise<Blob> {
		const dbx = getClient() as DropboxSdkClient | null;
		if (!dbx) {
			throw new Error('Dropbox에 연결되지 않았습니다');
		}
		const res = await dbx.sharingGetSharedLinkFile({ url });
		const blob = res.result.fileBlob;
		if (!blob) {
			throw new Error('Dropbox 이미지 응답이 비어 있습니다');
		}
		return blob;
	},
};
