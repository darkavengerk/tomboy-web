import { describe, it, expect } from 'vitest';
import { buildSlipNoteXml, formatSlipNoteTitle } from '$lib/sleepnote/create.js';
import { isSlipNoteTitle, validateSlipNoteFormat } from '$lib/sleepnote/validator.js';
import { createEmptyNote } from '$lib/core/note.js';

describe('formatSlipNoteTitle', () => {
	it('produces a title matching isSlipNoteTitle (date-time variant)', () => {
		const t = formatSlipNoteTitle(new Date(2026, 3, 19, 7, 5));
		expect(t).toBe('2026-04-19 07:05 새 노트');
		expect(isSlipNoteTitle(t)).toBe(true);
	});
});

describe('buildSlipNoteXml', () => {
	it('produces content that passes validateSlipNoteFormat as a standalone note', () => {
		const title = formatSlipNoteTitle(new Date(2026, 3, 19, 7, 5));
		const n = createEmptyNote('guid-slip');
		n.title = title;
		n.xmlContent = buildSlipNoteXml(title);

		const r = validateSlipNoteFormat(n);
		expect(r.issues).toEqual([]);
		expect(r.prev?.kind).toBe('none');
		expect(r.next?.kind).toBe('none');
	});

	it('escapes XML-special characters in the title', () => {
		const xml = buildSlipNoteXml('A & <B>');
		expect(xml).toContain('A &amp; &lt;B&gt;');
	});
});
