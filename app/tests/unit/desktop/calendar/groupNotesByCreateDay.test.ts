import { describe, it, expect } from 'vitest';
import { groupNotesByCreateDay } from '$lib/desktop/calendar/groupNotesByCreateDay.js';
import { formatTomboyDate } from '$lib/core/note.js';

// Build createDate strings in the viewer's local tz so bucketing is
// deterministic regardless of the CI machine timezone.
function note(guid: string, d: Date) {
	return { guid, title: guid, createDate: formatTomboyDate(d) };
}

function localKey(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe('groupNotesByCreateDay', () => {
	it('returns an empty map for no notes', () => {
		expect(groupNotesByCreateDay([]).size).toBe(0);
	});

	it('buckets notes created on the same local day together', () => {
		const day = new Date(2026, 6, 6, 9, 0, 0); // 2026-07-06 local
		const notes = [note('a', new Date(2026, 6, 6, 1, 0)), note('b', new Date(2026, 6, 6, 23, 30))];
		const map = groupNotesByCreateDay(notes);
		expect(map.size).toBe(1);
		expect(map.get(localKey(day))?.map((n) => n.guid).sort()).toEqual(['a', 'b']);
	});

	it('separates notes created on different days', () => {
		const notes = [note('a', new Date(2026, 6, 6, 12, 0)), note('b', new Date(2026, 6, 7, 12, 0))];
		const map = groupNotesByCreateDay(notes);
		expect(map.size).toBe(2);
		expect(map.get('2026-07-06')?.length).toBe(1);
		expect(map.get('2026-07-07')?.length).toBe(1);
	});

	it('sorts each day bucket by createDate ascending', () => {
		const notes = [note('late', new Date(2026, 6, 6, 20, 0)), note('early', new Date(2026, 6, 6, 6, 0))];
		const map = groupNotesByCreateDay(notes);
		expect(map.get('2026-07-06')?.map((n) => n.guid)).toEqual(['early', 'late']);
	});

	it('skips notes with an unparseable createDate', () => {
		const notes = [note('good', new Date(2026, 6, 6, 12, 0)), { guid: 'bad', title: 'bad', createDate: 'not-a-date' }];
		const map = groupNotesByCreateDay(notes);
		expect(map.size).toBe(1);
		expect(map.get('2026-07-06')?.map((n) => n.guid)).toEqual(['good']);
	});
});
