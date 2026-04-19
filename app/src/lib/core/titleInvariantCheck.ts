import * as noteStore from '$lib/storage/noteStore.js';
import type { NoteData } from './note.js';

export interface DuplicateTitleGroup {
	title: string;
	notes: Array<{ guid: string; changeDate: string }>;
}

/**
 * Pure: group non-deleted, non-template notes by (case-sensitive, trimmed)
 * title. Returns only groups with 2+ members, sorted alphabetically by title.
 * Inside a group, notes are sorted by changeDate descending (newest first).
 */
export function findDuplicateTitles(notes: NoteData[]): DuplicateTitleGroup[] {
	const byTitle = new Map<string, Array<{ guid: string; changeDate: string }>>();

	for (const n of notes) {
		if (n.deleted) continue;
		if (n.tags.includes('system:template')) continue;
		const key = n.title.trim();
		if (key === '') continue;

		const bucket = byTitle.get(key);
		const entry = { guid: n.guid, changeDate: n.changeDate };
		if (bucket) bucket.push(entry);
		else byTitle.set(key, [entry]);
	}

	const groups: DuplicateTitleGroup[] = [];
	for (const [title, members] of byTitle) {
		if (members.length < 2) continue;
		members.sort((a, b) => (b.changeDate > a.changeDate ? 1 : b.changeDate < a.changeDate ? -1 : 0));
		groups.push({ title, notes: members });
	}

	groups.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
	return groups;
}

/**
 * Async wrapper reading from the note store. Convenience for the admin page.
 */
export async function scanDuplicateTitles(): Promise<DuplicateTitleGroup[]> {
	const notes = await noteStore.getAllNotesIncludingTemplates();
	return findDuplicateTitles(notes);
}
