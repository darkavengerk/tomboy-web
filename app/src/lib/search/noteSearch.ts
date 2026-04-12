import type { NoteData } from '$lib/core/note.js';

export interface SearchResult {
	note: NoteData;
	/** Matched portion of the title or body */
	matchContext: string;
}

/**
 * Search notes by title and body content.
 * Strips XML tags before matching. Case-insensitive.
 */
export function searchNotes(notes: NoteData[], query: string, limit = 50): SearchResult[] {
	if (!query.trim()) return [];

	const lowerQuery = query.toLowerCase();
	const results: SearchResult[] = [];

	for (const note of notes) {
		if (note.deleted) continue;

		const titleMatch = note.title.toLowerCase().includes(lowerQuery);
		const bodyText = stripXmlTags(note.xmlContent);
		const bodyMatch = bodyText.toLowerCase().includes(lowerQuery);

		if (titleMatch || bodyMatch) {
			let matchContext = '';
			if (titleMatch) {
				matchContext = note.title;
			} else {
				const idx = bodyText.toLowerCase().indexOf(lowerQuery);
				const start = Math.max(0, idx - 30);
				const end = Math.min(bodyText.length, idx + query.length + 30);
				matchContext = (start > 0 ? '...' : '') + bodyText.substring(start, end) + (end < bodyText.length ? '...' : '');
			}

			results.push({ note, matchContext });

			if (results.length >= limit) break;
		}
	}

	return results;
}

function stripXmlTags(xml: string): string {
	return xml.replace(/<[^>]+>/g, '');
}
