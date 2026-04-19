/**
 * Title-rewrite helpers used by `importNoteXml` and the sync-pull path to
 * enforce the case-sensitive title uniqueness invariant at ALL data-entry
 * points. See Task #4.
 *
 * Pure functions — no DB access. The async helper takes its dependencies
 * explicitly so it can be tested without mocking the storage layer.
 */

import type { NoteData } from './note.js';

/**
 * Escape `&`, `<`, `>` for XML text content. Tomboy stores titles as XML
 * text (the first line inside `<note-content>`), not attributes, so quotes
 * don't need escaping.
 */
export function xmlEscapeTitle(title: string): string {
	return title
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Replace the title (first line inside `<note-content>`) with `newTitle`.
 * Preserves everything after the first `\n`.
 *
 * Assumes the input is well-formed Tomboy note-content — the caller
 * guarantees this (it came from `parseNote` / `parseNoteFromFile`).
 *
 * Defensive: if `<note-content>` is missing or the tag is unterminated,
 * the input is returned unchanged.
 */
export function rewriteTitleInNoteContentXml(xml: string, newTitle: string): string {
	const openTagMatch = xml.match(/<note-content[^>]*>/);
	if (!openTagMatch) return xml;
	const openEnd = xml.indexOf(openTagMatch[0]) + openTagMatch[0].length;
	const nlIdx = xml.indexOf('\n', openEnd);
	const closeIdx = xml.indexOf('</note-content>', openEnd);
	// Replacement ends at the first \n OR the closing tag, whichever comes
	// first. This lets single-line notes (title-only, no body) work too.
	let replacementEnd: number;
	if (nlIdx === -1) {
		if (closeIdx === -1) return xml;
		replacementEnd = closeIdx;
	} else if (closeIdx === -1) {
		replacementEnd = nlIdx;
	} else {
		replacementEnd = Math.min(nlIdx, closeIdx);
	}
	return xml.slice(0, openEnd) + xmlEscapeTitle(newTitle) + xml.slice(replacementEnd);
}

/**
 * Prepare an incoming note (from import or sync-pull) against the local
 * title uniqueness invariant. Pure — returns a new NoteData; does not
 * mutate the input.
 *
 * If another local note (DIFFERENT guid) already owns the trimmed title,
 * suffix with `(2)`, `(3)`, … until unique, rewrite the first line of
 * `xmlContent`, bump `metadataChangeDate` via `deps.now()`, and mark
 * `localDirty = true` so the renamed version propagates back on the next
 * sync.
 *
 * Same-guid matches are treated as self-hits (no rename). Empty /
 * whitespace titles are left alone (we don't suffix blanks).
 */
export async function prepareIncomingNoteForLocal(
	remoteNote: NoteData,
	deps: {
		findByTitle: (title: string) => Promise<{ guid: string } | undefined>;
		now: () => string;
	}
): Promise<{ renamed: boolean; from: string; to: string; note: NoteData }> {
	const out: NoteData = { ...remoteNote };
	const trimmed = out.title.trim();
	if (!trimmed) {
		return { renamed: false, from: out.title, to: out.title, note: out };
	}
	let candidate = trimmed;
	let n = 2;
	while (true) {
		const hit = await deps.findByTitle(candidate);
		if (!hit || hit.guid === out.guid) break;
		candidate = `${trimmed} (${n})`;
		n++;
	}
	if (candidate === trimmed) {
		// No rewrite needed — the trimmed title was already unique. Preserve
		// the incoming title byte-for-byte (including any surrounding
		// whitespace) so the note imports unchanged.
		return { renamed: false, from: out.title, to: out.title, note: out };
	}
	const from = out.title;
	out.title = candidate;
	out.xmlContent = rewriteTitleInNoteContentXml(out.xmlContent, candidate);
	out.metadataChangeDate = deps.now();
	out.localDirty = true;
	return { renamed: true, from, to: candidate, note: out };
}

/**
 * Literal (non-regex) replace-all for a substring. Returns the rewritten
 * source + whether any substitution actually happened. Safe for user-typed
 * titles that contain regex metacharacters (e.g. `.*`, `[x]`).
 */
function replaceAllLiteral(
	src: string,
	find: string,
	rep: string
): { out: string; changed: boolean } {
	if (!find || find === rep) return { out: src, changed: false };
	let out = '';
	let i = 0;
	let changed = false;
	while (true) {
		const j = src.indexOf(find, i);
		if (j === -1) {
			out += src.slice(i);
			break;
		}
		out += src.slice(i, j) + rep;
		i = j + find.length;
		changed = true;
	}
	return { out, changed };
}

/**
 * Scan `xml` for `<link:internal>OLD</link:internal>` and
 * `<link:broken>OLD</link:broken>` occurrences where `OLD === xmlEscapeTitle(oldTitle)`,
 * and rewrite them to use `xmlEscapeTitle(newTitle)`.
 *
 * Returns the rewritten xml and whether any substitution happened. O(xml
 * length) — uses literal substring match, not regex, so user-typed regex
 * metacharacters in titles are safe.
 */
export function rewriteInternalLinkRefsInXml(
	xml: string,
	oldTitle: string,
	newTitle: string
): { xml: string; changed: boolean } {
	if (oldTitle === newTitle) return { xml, changed: false };
	const oldEscaped = xmlEscapeTitle(oldTitle);
	const newEscaped = xmlEscapeTitle(newTitle);
	let working = xml;
	let anyChanged = false;
	{
		const r = replaceAllLiteral(
			working,
			`<link:internal>${oldEscaped}</link:internal>`,
			`<link:internal>${newEscaped}</link:internal>`
		);
		working = r.out;
		if (r.changed) anyChanged = true;
	}
	{
		const r = replaceAllLiteral(
			working,
			`<link:broken>${oldEscaped}</link:broken>`,
			`<link:broken>${newEscaped}</link:broken>`
		);
		working = r.out;
		if (r.changed) anyChanged = true;
	}
	return { xml: working, changed: anyChanged };
}
