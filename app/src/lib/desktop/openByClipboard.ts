import { getNote } from '$lib/core/noteManager.js';
import { pushToast } from '$lib/stores/toast.js';
import { desktopSession } from './session.svelte.js';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const BARE_UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');
const TOMBOY_URI_RE = new RegExp(`^note:\\/\\/tomboy\\/(${UUID_PATTERN})\\/?$`, 'i');
const WEB_URL_RE = new RegExp(
	`^https?:\\/\\/[^\\s]+?\\/note\\/(${UUID_PATTERN})(?:[\\/?#].*)?$`,
	'i'
);

/**
 * Extract a note GUID from a clipboard text snippet.
 *
 * Recognised forms (entire trimmed text must match — no substring search, so
 * arbitrary prose containing a UUID is ignored):
 *   - bare UUID:                `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
 *   - tomboy URI:               `note://tomboy/<uuid>`
 *   - app URL with `/note/<uuid>` path (any host, optional `?...#...`)
 */
export function extractNoteGuidFromText(text: string): string | null {
	const trimmed = (text ?? '').trim();
	if (!trimmed) return null;

	let m = BARE_UUID_RE.exec(trimmed);
	if (m) return m[0].toLowerCase();

	m = TOMBOY_URI_RE.exec(trimmed);
	if (m) return m[1].toLowerCase();

	m = WEB_URL_RE.exec(trimmed);
	if (m) return m[1].toLowerCase();

	return null;
}

/**
 * Look up `guid` in IDB and open it in a desktop window. Toasts on miss.
 * Used by the Ctrl+V paste handler after parsing a guid out of the native
 * paste event's clipboardData — going through the synchronous `paste`
 * event avoids the async Clipboard API permission prompt that browsers
 * show otherwise.
 */
export async function openNoteByGuid(guid: string): Promise<void> {
	const note = await getNote(guid);
	if (!note || note.deleted) {
		pushToast('해당 노트를 찾을 수 없습니다.', { kind: 'error' });
		return;
	}
	desktopSession.openWindow(guid);
}
