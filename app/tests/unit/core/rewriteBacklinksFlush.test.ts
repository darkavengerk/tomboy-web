import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';
import { subscribeNoteFlush, _resetForTest as resetBus } from '$lib/core/noteReloadBus.js';
import { _resetForTest as resetCache } from '$lib/stores/noteListCache.js';
import { _resetForTest as resetTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { _resetDBForTest } from '$lib/storage/db.js';

function makeNote(guid: string, title: string, body: string): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n${body}</note-content>`;
	return n;
}

const docTitled = (title: string) =>
	deserializeContent(`<note-content version="0.1">${title}\n</note-content>`);

beforeEach(() => {
	clearIndex();
	resetBus();
	resetCache();
	resetTitleProvider();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('rename sweep flushes backlinked target editors before rewriting', () => {
	it('lands a target editor pending edit instead of losing it', async () => {
		await putNote(makeNote('a', 'Foo', ''));
		await putNote(makeNote('b', 'Linker', '<link:internal>Foo</link:internal>'));

		// Simulate an open editor for B holding an unsaved body edit: when the
		// sweep flushes B, that edit lands in IDB (keeping the still-old link).
		let flushed = 0;
		subscribeNoteFlush('b', async () => {
			flushed++;
			const b = await getNote('b');
			if (!b) return;
			b.xmlContent =
				'<note-content version="0.1">Linker\nedited body <link:internal>Foo</link:internal></note-content>';
			await putNote(b);
		});

		await updateNoteFromEditor('a', docTitled('Bar'));

		// The flush ran exactly once, BEFORE the rewrite read B.
		expect(flushed).toBe(1);
		const after = await getNote('b');
		// The body edit survived AND the link was rewritten on top of it.
		expect(after?.xmlContent).toContain('edited body');
		expect(after?.xmlContent).toContain('<link:internal>Bar</link:internal>');
		expect(after?.xmlContent).not.toContain('>Foo<');
	});

	it('flushes only backlinked targets, not unrelated notes', async () => {
		await putNote(makeNote('a', 'Foo', ''));
		await putNote(makeNote('b', 'Linker', '<link:internal>Foo</link:internal>'));
		await putNote(makeNote('c', 'Unrelated', 'no link here'));

		const flushedGuids: string[] = [];
		subscribeNoteFlush('b', () => {
			flushedGuids.push('b');
		});
		subscribeNoteFlush('c', () => {
			flushedGuids.push('c');
		});

		await updateNoteFromEditor('a', docTitled('Bar'));
		expect(flushedGuids).toEqual(['b']);
	});

	it('never flushes the renamed note itself (self-guid excluded)', async () => {
		// A self-links, so it is among the sources of its own old title — the
		// sweep must still exclude it from the flush set.
		await putNote(makeNote('a', 'Foo', '<link:internal>Foo</link:internal>'));
		await putNote(makeNote('b', 'Linker', '<link:internal>Foo</link:internal>'));

		let selfFlush = 0;
		subscribeNoteFlush('a', () => {
			selfFlush++;
		});

		await updateNoteFromEditor('a', docTitled('Bar'));
		expect(selfFlush).toBe(0);
	});
});
