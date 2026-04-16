/**
 * Image upload to Dropbox with public shared-link generation.
 *
 * Contract:
 *   1. File uploads to `{imagesPath}/{uuid}.{ext}` — the extension is kept
 *      so Dropbox serves the right Content-Type when fetched as a raw link.
 *   2. A public shared link is created (no password, no expiry).
 *   3. The returned URL is transformed to a direct-viewable form
 *      (`?raw=1`) so `<img src>` can render it without an HTML intermediate.
 *
 * The image folder is intentionally separated from the notes sync tree —
 * `commitRevision` walks the notes tree and must never see unrelated files.
 *
 * Compatibility: the resulting URL is just a regular HTTPS URL. Pasted
 * into a Tomboy `.note` file (as a `<link:url>`), it round-trips cleanly
 * and the desktop client shows it as an ordinary link.
 */

import { getClient, getImagesPath } from './dropboxClient.js';

/**
 * Convert a Dropbox shared link to a direct, raw-bytes URL suitable for
 * `<img src>`. For non-Dropbox or unparseable URLs, the input is returned
 * unchanged so callers don't accidentally break anything.
 */
export function toDirectImageUrl(sharedUrl: string): string {
	let u: URL;
	try {
		u = new URL(sharedUrl);
	} catch {
		return sharedUrl;
	}
	const host = u.hostname;
	const isDropbox =
		host === 'dropbox.com' ||
		host.endsWith('.dropbox.com') ||
		host.endsWith('.dropboxusercontent.com');
	if (!isDropbox) return sharedUrl;

	// The `raw=1` trick makes www.dropbox.com serve the binary instead of
	// the HTML preview page. It coexists fine with other query params.
	u.searchParams.delete('dl');
	u.searchParams.set('raw', '1');
	return u.toString();
}

function fileExtension(file: File): string {
	const nameMatch = /\.([A-Za-z0-9]+)$/.exec(file.name);
	if (nameMatch) return nameMatch[1].toLowerCase();
	if (file.type.startsWith('image/')) {
		const sub = file.type.slice('image/'.length).toLowerCase();
		// MIME sometimes uses `jpeg` while filenames prefer `jpg`. Either
		// works with Dropbox Content-Type resolution.
		return sub === 'svg+xml' ? 'svg' : sub;
	}
	return 'bin';
}

function buildUploadPath(imagesPath: string, file: File): string {
	// crypto.randomUUID exists in all browsers we target (and in jsdom 16+).
	const uuid = crypto.randomUUID();
	const ext = fileExtension(file);
	const filename = `${uuid}.${ext}`;
	return imagesPath ? `${imagesPath}/${filename}` : `/${filename}`;
}

interface DropboxSdkClient {
	filesUpload: (arg: {
		path: string;
		contents: unknown;
		mode: { '.tag': string };
		mute?: boolean;
		autorename?: boolean;
	}) => Promise<unknown>;
	sharingCreateSharedLinkWithSettings: (arg: {
		path: string;
		settings?: Record<string, unknown>;
	}) => Promise<{ result: { url: string } }>;
	sharingListSharedLinks: (arg: {
		path: string;
		direct_only?: boolean;
	}) => Promise<{ result: { links: Array<{ url: string }> } }>;
}

/**
 * Extract a recoverable URL from a `shared_link_already_exists` error, if
 * present. Dropbox returns this in a few slightly different shapes across
 * SDK versions, so we look in two common locations.
 */
function extractExistingSharedUrl(err: unknown): string | null {
	const e = err as {
		error?: {
			error?: { shared_link_already_exists?: { metadata?: { url?: string } } };
			shared_link_already_exists?: { metadata?: { url?: string } };
		};
	};
	return (
		e.error?.error?.shared_link_already_exists?.metadata?.url ??
		e.error?.shared_link_already_exists?.metadata?.url ??
		null
	);
}

function isSharedLinkAlreadyExists(err: unknown): boolean {
	const e = err as {
		error?: {
			error?: { '.tag'?: string; shared_link_already_exists?: unknown };
			shared_link_already_exists?: unknown;
			'.tag'?: string;
		};
	};
	return (
		e.error?.error?.['.tag'] === 'shared_link_already_exists' ||
		e.error?.['.tag'] === 'shared_link_already_exists' ||
		e.error?.error?.shared_link_already_exists !== undefined ||
		e.error?.shared_link_already_exists !== undefined
	);
}

async function resolveSharedUrl(
	dbx: DropboxSdkClient,
	path: string
): Promise<string> {
	try {
		const res = await dbx.sharingCreateSharedLinkWithSettings({ path });
		return res.result.url;
	} catch (err) {
		if (!isSharedLinkAlreadyExists(err)) throw err;

		// Prefer the URL embedded in the error metadata — it's the cheapest.
		const embedded = extractExistingSharedUrl(err);
		if (embedded) return embedded;

		// Fallback: list the existing shared links for this exact path.
		const listRes = await dbx.sharingListSharedLinks({
			path,
			direct_only: true
		});
		const first = listRes.result.links[0];
		if (!first) throw err;
		return first.url;
	}
}

/**
 * Upload an image file to the configured Dropbox image folder and return
 * a direct URL that can be used as `<img src>` or embedded in a note.
 */
export async function uploadImageToDropbox(file: File): Promise<string> {
	const dbx = getClient() as DropboxSdkClient | null;
	if (!dbx) {
		throw new Error('Dropbox에 연결되지 않았습니다');
	}

	const imagesPath = getImagesPath();
	const path = buildUploadPath(imagesPath, file);

	await dbx.filesUpload({
		path,
		contents: file,
		mode: { '.tag': 'add' },
		mute: true,
		autorename: false
	});

	const sharedUrl = await resolveSharedUrl(dbx, path);
	return toDirectImageUrl(sharedUrl);
}
