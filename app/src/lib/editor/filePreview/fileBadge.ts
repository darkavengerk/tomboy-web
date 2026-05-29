/**
 * Build the inline badge DOM for a bridge file URL.
 * Pure helpers — no editor state, easy to unit-test.
 */

export function filenameFromUrl(url: string): string {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return '파일';
	}
	// Take the last segment as-is (don't filter empties) so a trailing
	// slash produces an empty filename → fallback to '파일'.
	const segments = path.split('/');
	const last = segments[segments.length - 1] ?? '';
	if (!last) return '파일';
	try {
		const decoded = decodeURIComponent(last);
		return decoded || '파일';
	} catch {
		return '파일';
	}
}

export function createFileBadgeElement(url: string): HTMLAnchorElement {
	const a = document.createElement('a');
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	a.className = 'tomboy-file-badge';
	a.setAttribute('contenteditable', 'false');
	a.draggable = false;
	a.textContent = `📎 ${filenameFromUrl(url)}`;
	// Block PM selection-on-mousedown so a tap doesn't jam the caret into
	// the hidden URL text (mirrors imagePreviewPlugin behavior).
	a.addEventListener('mousedown', (e) => {
		e.preventDefault();
	});
	// Explicit navigation: inside PM's editable contenteditable the
	// browser's default `<a target=_blank>` action doesn't fire reliably
	// (especially on mobile Safari/Chrome where the tap registers but the
	// new tab never opens). Force the open ourselves the same way
	// imagePreviewPlugin opens its viewer.
	a.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		window.open(url, '_blank', 'noopener,noreferrer');
	});
	return a;
}
