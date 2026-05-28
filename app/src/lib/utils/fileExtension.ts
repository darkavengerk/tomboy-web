/**
 * Pick a reasonable filename extension for an image file. Prefers the
 * actual filename extension (lowercased) when present, falls back to the
 * MIME subtype (normalising `svg+xml` → `svg`), and defaults to `bin`
 * for non-image files with no extension.
 *
 * MIME sometimes uses `jpeg` while filenames prefer `jpg`. Either form
 * works with Dropbox + Vercel Blob Content-Type resolution.
 */
export function fileExtension(file: File): string {
	const nameMatch = /\.([A-Za-z0-9]+)$/.exec(file.name);
	if (nameMatch) return nameMatch[1].toLowerCase();
	if (file.type.startsWith('image/')) {
		const sub = file.type.slice('image/'.length).toLowerCase();
		return sub === 'svg+xml' ? 'svg' : sub;
	}
	return 'bin';
}
