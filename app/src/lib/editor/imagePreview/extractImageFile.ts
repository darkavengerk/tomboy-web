/**
 * Pull the first `image/*` File out of a paste / drop event's DataTransfer.
 *
 * Returns null when there's no image. Prefers the richer `items` API
 * (which carries MIME metadata even for pasted bitmaps from the clipboard)
 * and falls back to `files` for drag-and-drop operations where `items`
 * may be missing or empty in some browsers.
 */
export function extractImageFile(dt: DataTransfer | null): File | null {
	if (!dt) return null;

	if (dt.items && dt.items.length > 0) {
		for (let i = 0; i < dt.items.length; i++) {
			const item = dt.items[i];
			if (item.kind !== 'file') continue;
			if (!item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (file) return file;
		}
	}

	if (dt.files && dt.files.length > 0) {
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (file.type.startsWith('image/')) return file;
		}
	}

	return null;
}
