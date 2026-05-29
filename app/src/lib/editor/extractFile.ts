/**
 * Pull the first file out of a paste/drop DataTransfer, with image priority.
 *
 * Returns null when there's no file. Prefers an image when both image and
 * non-image files are present — mirrors the convention that image paste is
 * the established Vercel Blob flow; only fall through to the bridge
 * `uploadAndInsertFile` path when nothing image-shaped is in the payload.
 *
 * The `isImage` flag on the result lets callers branch without re-checking
 * MIME themselves and keeps the image-vs-file decision in one place.
 */
export interface ExtractedFile {
	file: File;
	isImage: boolean;
}

export function extractAnyFile(dt: DataTransfer | null): ExtractedFile | null {
	if (!dt) return null;

	// Pass 1: image priority via items API (carries MIME for clipboard bitmaps).
	if (dt.items && dt.items.length > 0) {
		for (let i = 0; i < dt.items.length; i++) {
			const item = dt.items[i];
			if (item.kind !== 'file') continue;
			if (!item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (file) return { file, isImage: true };
		}
		// Pass 2: any file.
		for (let i = 0; i < dt.items.length; i++) {
			const item = dt.items[i];
			if (item.kind !== 'file') continue;
			const file = item.getAsFile();
			if (file) return { file, isImage: file.type.startsWith('image/') };
		}
	}

	// Fallback: files API for drag-drop where items may be empty in some browsers.
	if (dt.files && dt.files.length > 0) {
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (file.type.startsWith('image/')) return { file, isImage: true };
		}
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			return { file, isImage: file.type.startsWith('image/') };
		}
	}

	return null;
}
