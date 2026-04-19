import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSlipNoteXml, createSlipNote } from '$lib/sleepnote/create.js';
import { formatDateTimeTitle } from '$lib/core/noteManager.js';
import { isSlipNoteTitle, validateSlipNoteFormat } from '$lib/sleepnote/validator.js';
import { createEmptyNote } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { getNote } from '$lib/storage/noteStore.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('formatDateTimeTitle', () => {
	it('produces a plain yyyy-mm-dd HH:mm string', () => {
		expect(formatDateTimeTitle(new Date(2026, 3, 19, 7, 5))).toBe('2026-04-19 07:05');
	});

	it('result matches isSlipNoteTitle (date-time variant)', () => {
		const t = formatDateTimeTitle(new Date(2026, 3, 19, 7, 5));
		expect(isSlipNoteTitle(t)).toBe(true);
	});
});

describe('buildSlipNoteXml', () => {
	it('produces content that passes validateSlipNoteFormat as a standalone note', () => {
		const title = formatDateTimeTitle(new Date(2026, 3, 19, 7, 5));
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

describe('createSlipNote — title is the plain date-time (no " 새 노트" suffix)', () => {
	it('persists a note whose title matches yyyy-mm-dd HH:mm', async () => {
		const n = await createSlipNote();
		expect(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: \(\d+\))?$/.test(n.title)).toBe(true);

		const stored = await getNote(n.guid);
		const r = validateSlipNoteFormat(stored!);
		expect(r.issues).toEqual([]);
	});
});
