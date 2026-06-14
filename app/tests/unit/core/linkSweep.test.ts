import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { _resetForTest as resetCache } from '$lib/stores/noteListCache.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';
import { countLinkSweep, applyLinkSweep } from '$lib/core/linkSweep.js';

async function seed(guid: string, title: string, body: string, deleted = false) {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n${body}\n\n</note-content>`;
	n.deleted = deleted;
	await noteStore.putNote(n);
}

beforeEach(() => {
	clearIndex();
	resetCache();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('countLinkSweep', () => {
	it('returns only notes that would gain a link', async () => {
		await seed('g1', 'Apple', 'I like Apple pie');  // matches "Apple"
		await seed('g2', 'Banana', 'no fruit here');    // no match
		await seed('gT', 'Apple', '');                  // the target itself
		const { matched } = await countLinkSweep('Apple', 'gT');
		expect(matched).toEqual(['g1']);
	});

	it('excludes the target note itself', async () => {
		await seed('gT', 'Apple', 'Apple is great');
		const { matched } = await countLinkSweep('Apple', 'gT');
		expect(matched).not.toContain('gT');
	});

	it('excludes deleted notes', async () => {
		await seed('g1', 'Note A', 'Apple here', true /* deleted */);
		const { matched } = await countLinkSweep('Apple', 'gT');
		expect(matched).not.toContain('g1');
	});

	it('excludes notes whose xmlContent lacks the title substring (prefilter)', async () => {
		await seed('g1', 'Note A', 'no match at all');
		const { matched } = await countLinkSweep('Apple', 'gT');
		expect(matched).toHaveLength(0);
	});

	it('matches titles with XML-special chars (body stores them escaped)', async () => {
		// Real serialization escapes & < > in body text, so the prefilter must
		// probe the escaped form. xmlContent here holds "R&amp;D" as it would
		// on disk; the raw title is "R&D". The old raw-substring probe missed it.
		await seed('g1', 'Other', 'see R&amp;D here');
		const { matched } = await countLinkSweep('R&D', 'gT');
		expect(matched).toEqual(['g1']);
	});

	it('does not count already-linked notes (idempotent)', async () => {
		// Seed a note that already has the link mark in XML
		const n = createEmptyNote('g1');
		n.title = 'Note';
		n.xmlContent =
			'<note-content version="0.1">Note\nsee <link:internal>Apple</link:internal> here\n\n</note-content>';
		await noteStore.putNote(n);
		const { matched } = await countLinkSweep('Apple', 'gT');
		expect(matched).not.toContain('g1');
	});

	it('reports total as candidate count (prefilter pass), not all notes', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'no match');
		const { total, matched } = await countLinkSweep('Apple', 'gT');
		// g2 is excluded by prefilter, so total = 1 (only notes that passed substring check)
		expect(total).toBe(1);
		expect(matched).toEqual(['g1']);
	});

	it('respects cancel token — stops early', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'Apple there');
		const token = { cancelled: true };
		const { matched } = await countLinkSweep('Apple', 'gT', { cancelToken: token });
		// cancelled immediately → no notes processed
		expect(matched).toHaveLength(0);
	});

	it('calls onProgress for each candidate', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'Apple there');
		const progress: Array<{ scanned: number; total: number }> = [];
		await countLinkSweep('Apple', 'gT', {
			onProgress: (p) => progress.push({ scanned: p.scanned, total: p.total })
		});
		expect(progress).toHaveLength(2);
		expect(progress[0].scanned).toBe(1);
		expect(progress[1].scanned).toBe(2);
	});
});

describe('applyLinkSweep', () => {
	it('writes link marks and getNote reflects them in xmlContent', async () => {
		await seed('g1', 'Note', 'see Apple now');
		await applyLinkSweep('Apple', 'gT', ['g1']);
		const after = await noteStore.getNote('g1');
		expect(after!.xmlContent).toContain('<link:internal>Apple</link:internal>');
	});

	it('is idempotent — second countLinkSweep sees zero after apply', async () => {
		await seed('g1', 'Note', 'see Apple now');
		await applyLinkSweep('Apple', 'gT', ['g1']);
		const second = await countLinkSweep('Apple', 'gT');
		expect(second.matched).not.toContain('g1');
	});

	it('returns { updated, failed } with correct counts', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'Apple there');
		const r = await applyLinkSweep('Apple', 'gT', ['g1', 'g2']);
		expect(r.updated).toEqual(expect.arrayContaining(['g1', 'g2']));
		expect(r.updated).toHaveLength(2);
		expect(r.failed).toBe(0);
	});

	it('increments failed on per-note error and does not abort the loop', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'Apple there');
		// Simulate a putNote failure for the first call only.
		// Capture the original before installing the spy.
		const realPutNote = noteStore.putNote.bind(noteStore);
		const putSpy = vi
			.spyOn(noteStore, 'putNote')
			.mockImplementationOnce(() => Promise.reject(new Error('IDB write failure')))
			.mockImplementation(realPutNote);
		try {
			const r = await applyLinkSweep('Apple', 'gT', ['g1', 'g2']);
			// g1 → putNote throws (mocked once) → failed++; g2 → real putNote succeeds
			expect(r.failed).toBe(1);
			expect(r.updated).toContain('g2');
		} finally {
			putSpy.mockRestore();
		}
	});

	it('cancel stops apply before processing and returns subset written so far', async () => {
		await seed('a', 'Note A', 'Apple here');
		await seed('b', 'Note B', 'Apple there');
		const token = { cancelled: true };
		const r = await applyLinkSweep('Apple', 'gT', ['a', 'b'], { cancelToken: token });
		// cancelled immediately before first iteration
		expect(r.updated).toHaveLength(0);
		expect(r.failed).toBe(0);
	});

	it('skip (no change) note does not appear in updated', async () => {
		await seed('g1', 'Note', 'no match here');
		// g1 passes as a guid but addInternalLinksForTitle finds no match → changed=false
		const r = await applyLinkSweep('Apple', 'gT', ['g1']);
		expect(r.updated).not.toContain('g1');
	});

	it('calls onProgress after each guid', async () => {
		await seed('g1', 'Note A', 'Apple here');
		await seed('g2', 'Note B', 'Apple there');
		const progress: number[] = [];
		await applyLinkSweep('Apple', 'gT', ['g1', 'g2'], {
			onProgress: (p) => progress.push(p.scanned)
		});
		expect(progress).toEqual([1, 2]);
	});
});
