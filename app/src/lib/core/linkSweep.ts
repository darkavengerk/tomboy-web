import { getAllNotesIncludingDeleted, getNote, putNote } from '$lib/storage/noteStore.js';
import { deserializeContent, serializeContent } from './noteContentArchiver.js';
import { addInternalLinksForTitle } from '$lib/editor/autoLink/linkifyDocJson.js';
import { noteMutated } from '$lib/stores/noteListCache.js';
import { xmlEscapeTitle } from './titleRewrite.js';

export interface CancelToken {
	cancelled: boolean;
}

export interface SweepProgress {
	scanned: number;
	total: number;
	matched: number;
}

type OnProgress = (p: SweepProgress) => void;

/**
 * Notes whose raw xmlContent contains the title substring (cheap prefilter),
 * excluding the target note and deleted notes.
 * Returns the full corpus without template exclusion (templates can have links too).
 */
async function candidates(title: string, targetGuid: string) {
	const all = await getAllNotesIncludingDeleted();
	// Probe the XML-ESCAPED title: body text in xmlContent is stored with &,<,>
	// escaped, so includes(rawTitle) would false-negative for titles containing
	// those characters. xmlEscapeTitle matches the archiver's body escaping.
	const probe = xmlEscapeTitle(title);
	return all.filter((n) => !n.deleted && n.guid !== targetGuid && n.xmlContent.includes(probe));
}

/**
 * Count notes that WOULD gain a `tomboyInternalLink` mark for `title` / `targetGuid`.
 *
 * - Cheap XML substring prefilter: notes without `title` in their raw xmlContent
 *   are skipped before any JSON parse.
 * - Already-linked notes are NOT counted (addInternalLinksForTitle is idempotent).
 * - Excludes the target note itself and deleted notes.
 * - Supports progress callbacks and cancellation.
 */
export async function countLinkSweep(
	title: string,
	targetGuid: string,
	opts: { onProgress?: OnProgress; cancelToken?: CancelToken } = {}
): Promise<{ matched: string[]; total: number }> {
	const cands = await candidates(title, targetGuid);
	const matched: string[] = [];

	for (let i = 0; i < cands.length; i++) {
		if (opts.cancelToken?.cancelled) break;
		const n = cands[i];
		try {
			const { changed } = addInternalLinksForTitle(
				deserializeContent(n.xmlContent),
				title,
				targetGuid
			);
			if (changed) matched.push(n.guid);
		} catch {
			// Unparseable note — skip in count, don't abort
		}
		opts.onProgress?.({ scanned: i + 1, total: cands.length, matched: matched.length });
	}

	return { matched, total: cands.length };
}

/**
 * Apply `tomboyInternalLink` marks for `title` / `targetGuid` to the given `guids`.
 *
 * - Only writes notes where addInternalLinksForTitle reports `changed: true`.
 * - A per-note throw increments `failed` without aborting the loop.
 * - Respects `cancelToken.cancelled`: stops iteration and returns the subset written so far.
 * - Each written note is persisted via `putNote` (maintains backlink index) and
 *   announced via `noteMutated` (patches the warm note-list cache).
 */
export async function applyLinkSweep(
	title: string,
	targetGuid: string,
	guids: string[],
	opts: { onProgress?: OnProgress; cancelToken?: CancelToken } = {}
): Promise<{ updated: string[]; failed: number }> {
	const updated: string[] = [];
	let failed = 0;

	for (let i = 0; i < guids.length; i++) {
		if (opts.cancelToken?.cancelled) break;
		try {
			const n = await getNote(guids[i]);
			if (n) {
				const { docJson, changed } = addInternalLinksForTitle(
					deserializeContent(n.xmlContent),
					title,
					targetGuid
				);
				if (changed) {
					n.xmlContent = serializeContent(docJson);
					await putNote(n);
					noteMutated(n);
					updated.push(n.guid);
				}
			}
		} catch {
			failed++;
		}
		// Outside try so every attempted guid advances progress (incl. not-found
		// and already-linked notes), keeping scanned in lockstep with total.
		opts.onProgress?.({ scanned: i + 1, total: guids.length, matched: updated.length });
	}

	return { updated, failed };
}
