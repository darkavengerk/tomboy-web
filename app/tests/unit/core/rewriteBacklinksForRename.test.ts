import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	getSourcesFor,
	clear as clearIndex
} from '$lib/core/backlinkIndex.js';
import { createEmptyNote } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { _resetDBForTest } from '$lib/storage/db.js';

function makeNote(guid: string, title: string, body: string) {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n${body}</note-content>`;
	return n;
}

describe('rewriteBacklinksForRename via backlinkIndex', () => {
	beforeEach(() => {
		clearIndex();
		globalThis.indexedDB = new IDBFactory();
		_resetDBForTest();
	});

	it('rename hits only indexed sources and rewrites both internal and broken marks', async () => {
		await putNote(makeNote('a', 'Foo', ''));
		await putNote(makeNote('b', 'Linker', '<link:internal>Foo</link:internal>'));
		await putNote(makeNote('c', 'BrokenLinker', '<link:broken>Foo</link:broken>'));
		await putNote(makeNote('d', 'Unrelated', '<p>just text</p>'));

		expect(getSourcesFor('Foo')).toEqual(new Set(['b', 'c']));

		const docWithBarTitle = deserializeContent(
			`<note-content version="0.1">Bar\n</note-content>`
		);
		await updateNoteFromEditor('a', docWithBarTitle);

		const after_b = await getNote('b');
		const after_c = await getNote('c');
		const after_d = await getNote('d');
		expect(after_b?.xmlContent).toContain('<link:internal>Bar</link:internal>');
		expect(after_b?.xmlContent).not.toContain('Foo');
		expect(after_c?.xmlContent).toContain('<link:broken>Bar</link:broken>');
		expect(after_d?.xmlContent).toBe(
			makeNote('d', 'Unrelated', '<p>just text</p>').xmlContent
		);

		expect(getSourcesFor('Foo')).toBeUndefined();
		expect(getSourcesFor('Bar')).toEqual(new Set(['b', 'c']));
	});

	it('soft-deleted source is skipped', async () => {
		await putNote(makeNote('a', 'Foo', ''));
		const b = makeNote('b', 'Linker', '<link:internal>Foo</link:internal>');
		b.deleted = true;
		await putNote(b);

		expect(getSourcesFor('Foo')).toBeUndefined();

		const docWithBarTitle = deserializeContent(
			`<note-content version="0.1">Bar\n</note-content>`
		);
		await updateNoteFromEditor('a', docWithBarTitle);

		const after_b = await getNote('b');
		expect(after_b?.deleted).toBe(true);
		expect(after_b?.xmlContent).toContain('Foo');
	});

	it('no-op when oldTitle has no backlinks', async () => {
		await putNote(makeNote('a', 'Foo', ''));
		const unrelated = makeNote('d', 'Unrelated', '<p>just text</p>');
		await putNote(unrelated);
		const initialChangeDate = unrelated.changeDate;

		const docWithBarTitle = deserializeContent(
			`<note-content version="0.1">Bar\n</note-content>`
		);
		await updateNoteFromEditor('a', docWithBarTitle);

		const after_d = await getNote('d');
		expect(after_d?.changeDate).toBe(initialChangeDate);
	});
});
