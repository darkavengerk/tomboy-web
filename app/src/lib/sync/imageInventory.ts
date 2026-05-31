/**
 * Cross-channel image inventory for the admin "이미지" page.
 *
 * Builds a single list by walking every local note's xmlContent for
 * image URLs (via `isImageUrl`) and unioning that with the Vercel Blob
 * `list()` result. The union catches orphan blobs (no note references
 * them) so the user can clean them up.
 *
 * In-memory only — re-runs on every admin page load. Cheap because the
 * note store is local IDB and Vercel's list call is one HTTP roundtrip.
 */

import { getAllNotes } from '$lib/storage/noteStore.js';
import { isImageUrl } from '$lib/editor/imagePreview/isImageUrl.js';
import { listTempImages, type TempImageListItem } from './tempImageUpload.js';

export type ImageStorage = 'temp' | 'dropbox' | 'external';

export interface ImageNoteRef {
	guid: string;
	title: string;
}

export interface ImageInventoryItem {
	url: string;
	storage: ImageStorage;
	size?: number;
	uploadedAt?: string;
	usedIn: ImageNoteRef[];
	isOrphan: boolean;
}

export interface ImageInventory {
	items: ImageInventoryItem[];
	listError: string | null;
}

/**
 * Classify by URL host. Returns 'external' for anything not recognised
 * (including unparseable strings).
 */
export function classifyImageUrl(url: string): ImageStorage {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'external';
	}
	const host = parsed.hostname;
	if (host.endsWith('.public.blob.vercel-storage.com')) return 'temp';
	if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) return 'dropbox';
	if (host.endsWith('.dropboxusercontent.com')) return 'dropbox';
	return 'external';
}

// Match anything between <link:url>...</link:url> tags in xmlContent.
// xmlContent stores URLs as raw text inside that tag.
const LINK_URL_RE = /<link:url>([^<]+)<\/link:url>/g;

interface ScanRow {
	url: string;
	storage: ImageStorage;
	usedIn: ImageNoteRef[];
}

/**
 * Walk every non-deleted note and extract image URLs from `<link:url>`
 * tags. Returns one row per distinct URL, with `usedIn` listing every
 * note that references it (deduped per-note).
 */
export async function scanNotesForImages(): Promise<ScanRow[]> {
	const notes = await getAllNotes();
	const map = new Map<string, ScanRow>();

	for (const note of notes) {
		if (note.deleted) continue;
		const xml = note.xmlContent ?? '';
		let m: RegExpExecArray | null;
		LINK_URL_RE.lastIndex = 0;
		while ((m = LINK_URL_RE.exec(xml)) !== null) {
			const url = m[1].trim();
			if (!isImageUrl(url)) continue;
			let row = map.get(url);
			if (!row) {
				row = { url, storage: classifyImageUrl(url), usedIn: [] };
				map.set(url, row);
			}
			if (!row.usedIn.some((u) => u.guid === note.guid)) {
				row.usedIn.push({ guid: note.guid, title: note.title });
			}
		}
	}

	return Array.from(map.values());
}

/**
 * Build the unified inventory. Vercel list failures degrade gracefully:
 * the note-scan rows are still returned, and `listError` carries the
 * error message for the UI to surface.
 */
export async function loadImageInventory(): Promise<ImageInventory> {
	const scan = await scanNotesForImages();

	let blobItems: TempImageListItem[] = [];
	let listError: string | null = null;
	try {
		const result = await listTempImages();
		blobItems = result.items;
	} catch (err) {
		listError = err instanceof Error ? err.message : String(err);
	}

	const byUrl = new Map(scan.map((r) => [r.url, r]));

	const items: ImageInventoryItem[] = [];
	const seenBlobUrls = new Set<string>();

	for (const blob of blobItems) {
		seenBlobUrls.add(blob.url);
		const scanRow = byUrl.get(blob.url);
		items.push({
			url: blob.url,
			storage: 'temp',
			size: blob.size,
			uploadedAt: blob.uploadedAt,
			usedIn: scanRow?.usedIn ?? [],
			isOrphan: !scanRow || scanRow.usedIn.length === 0
		});
	}

	for (const row of scan) {
		if (seenBlobUrls.has(row.url)) continue;
		items.push({
			url: row.url,
			storage: row.storage,
			usedIn: row.usedIn,
			isOrphan: false
		});
	}

	return { items, listError };
}
