import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	splitTerminalDoc,
	applyCommandsToDoc,
	removeItemFromDoc,
	clearHistoryFromDoc
} from '$lib/editor/terminal/historyStore.js';
import type { JSONContent } from '@tiptap/core';

function metaDoc(): JSONContent {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] }
		]
	};
}

function metaWithHistory(items: string[]): JSONContent {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
			{ type: 'paragraph' },
			{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
			{
				type: 'bulletList',
				content: items.map((t) => ({
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
				}))
			}
		]
	};
}

function readHistory(doc: JSONContent): string[] {
	return splitTerminalDoc(doc).historyItems;
}

describe('historyStore — pure doc helpers', () => {
	it('appends to a doc with no history section', () => {
		const out = applyCommandsToDoc(metaDoc(), ['ls -la']);
		expect(readHistory(out)).toEqual(['ls -la']);
	});

	it('prepends new commands', () => {
		const out = applyCommandsToDoc(metaWithHistory(['old1', 'old2']), ['fresh']);
		expect(readHistory(out)).toEqual(['fresh', 'old1', 'old2']);
	});

	it('dedups via move-to-top', () => {
		const out = applyCommandsToDoc(metaWithHistory(['a', 'b', 'c']), ['b']);
		expect(readHistory(out)).toEqual(['b', 'a', 'c']);
	});

	it('caps at 50', () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `cmd${i}`);
		const out = applyCommandsToDoc(metaWithHistory(fifty), ['NEW']);
		const got = readHistory(out);
		expect(got.length).toBe(50);
		expect(got[0]).toBe('NEW');
		expect(got[got.length - 1]).toBe('cmd48');
	});

	it('handles a batch of commands in order (last-most-recent)', () => {
		const out = applyCommandsToDoc(metaWithHistory([]), ['a', 'b', 'c']);
		expect(readHistory(out)).toEqual(['c', 'b', 'a']);
	});

	it('removeItemFromDoc removes by index', () => {
		const out = removeItemFromDoc(metaWithHistory(['a', 'b', 'c']), 1);
		expect(readHistory(out)).toEqual(['a', 'c']);
	});

	it('removeItemFromDoc no-ops on out-of-range', () => {
		const before = metaWithHistory(['a']);
		const after = removeItemFromDoc(before, 5);
		expect(after).toEqual(before);
	});

	it('clearHistoryFromDoc removes the section entirely', () => {
		const out = clearHistoryFromDoc(metaWithHistory(['a', 'b']));
		expect(splitTerminalDoc(out).hasHistorySection).toBe(false);
	});

	it('preserves bridge line when adding history', () => {
		const docWithBridge: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'bridge: wss://x/ws' }] }
			]
		};
		const out = applyCommandsToDoc(docWithBridge, ['cmd']);
		const blocks = (out.content ?? []) as JSONContent[];
		expect(blocks[2]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'bridge: wss://x/ws' }] });
		expect(readHistory(out)).toEqual(['cmd']);
	});
});

// ── Integration tests against real IDB (fake-indexeddb) ──────────────

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import {
	appendCommandToTerminalHistory,
	flushTerminalHistoryNow,
	clearTerminalHistory,
	removeCommandFromTerminalHistory,
	_resetForTest
} from '$lib/editor/terminal/historyStore.js';

vi.mock('$lib/sync/firebase/orchestrator.js', () => ({
	notifyNoteSaved: vi.fn()
}));

async function seedTerminalNote(guid: string, items: string[] = []): Promise<void> {
	const note = createEmptyNote(guid);
	note.title = 'Title';
	note.xmlContent = serializeContent(metaWithHistory(items));
	await putNote(note);
}

describe('historyStore — IDB integration', () => {
	beforeEach(() => {
		globalThis.indexedDB = new IDBFactory();
		_resetDBForTest();
		_resetForTest();
	});

	it('appendCommandToTerminalHistory writes after debounce', async () => {
		const guid = 'g1';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, 'cmd1');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).toContain('cmd1');
	});

	it('coalesces multiple appends within debounce', async () => {
		const guid = 'g2';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, 'a');
		appendCommandToTerminalHistory(guid, 'b');
		appendCommandToTerminalHistory(guid, 'c');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		// Order: most recent first, so c, b, a.
		expect(after?.xmlContent).toMatch(/c[\s\S]*b[\s\S]*a/);
	});

	it('rejects whitespace-prefixed commands', async () => {
		const guid = 'g3';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, ' secret');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).not.toContain('secret');
	});

	it('aborts silently when note is no longer a terminal note', async () => {
		const guid = 'g4';
		const note = createEmptyNote(guid);
		note.title = 'Plain';
		note.xmlContent = serializeContent({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }]
		});
		await putNote(note);
		appendCommandToTerminalHistory(guid, 'cmd');
		await expect(flushTerminalHistoryNow(guid)).resolves.toBeUndefined();
	});

	it('clearTerminalHistory removes the section', async () => {
		const guid = 'g5';
		await seedTerminalNote(guid, ['a', 'b']);
		await clearTerminalHistory(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).not.toContain('history:');
	});

	it('removeCommandFromTerminalHistory drops the right index', async () => {
		const guid = 'g6';
		await seedTerminalNote(guid, ['a', 'b', 'c']);
		await removeCommandFromTerminalHistory(guid, 1);
		const after = await getNote(guid);
		expect(after?.xmlContent).toContain('a');
		expect(after?.xmlContent).not.toContain('>b<'); // crude check — the trimmed value 'b' should no longer be a list-item text
		expect(after?.xmlContent).toContain('c');
	});

	it('removeCommandFromTerminalHistory waits for pending append', async () => {
		const guid = 'g-serial';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, 'cmd'); // queued, not flushed
		// removeCommandFromTerminalHistory must flush the queue first, then remove index 0
		await removeCommandFromTerminalHistory(guid, 0);
		const after = await getNote(guid);
		// 'cmd' was appended then removed — history should be empty
		expect(after?.xmlContent).not.toContain('cmd');
	});
});
