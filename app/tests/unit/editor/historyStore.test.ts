import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	splitTerminalDoc,
	applyCommandsToDoc,
	removeItemFromDoc,
	clearHistoryFromDoc,
	splitTerminalDocByKey,
	pinCommandInDoc,
	unpinCommandInDoc
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

	it('caps at 20', () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `cmd${i}`);
		const out = applyCommandsToDoc(metaWithHistory(twenty), ['NEW']);
		const got = readHistory(out);
		expect(got.length).toBe(20);
		expect(got[0]).toBe('NEW');
		expect(got[got.length - 1]).toBe('cmd18');
	});

	it('cap boundary: 21 commands yields exactly 20, oldest dropped', () => {
		let doc = metaDoc();
		for (let i = 0; i < 21; i++) {
			doc = applyCommandsToDoc(doc, [`cmd${i}`]);
		}
		const got = readHistory(doc);
		expect(got.length).toBe(20);
		expect(got[0]).toBe('cmd20');
		expect(got[got.length - 1]).toBe('cmd1');
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
	pinCommandInTerminalHistory,
	unpinCommandInTerminalHistory,
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

describe('historyStore — multi-section helpers', () => {
	function metaWithSections(sections: Record<string, string[]>): JSONContent {
		const blocks: JSONContent[] = [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] }
		];
		const keys = Object.keys(sections).sort((a, b) => {
			if (a === '') return -1;
			if (b === '') return 1;
			return a.localeCompare(b);
		});
		for (const key of keys) {
			blocks.push({ type: 'paragraph' });
			const headerText = key === '' ? 'history:' : `history:${key}:`;
			blocks.push({ type: 'paragraph', content: [{ type: 'text', text: headerText }] });
			blocks.push({
				type: 'bulletList',
				content: sections[key].map((t) => ({
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
				}))
			});
		}
		return { type: 'doc', content: blocks };
	}

	it('splitTerminalDocByKey returns all buckets and pre blocks', () => {
		const doc = metaWithSections({ '': ['out1'], 'tmux:@1': ['in1', 'in2'] });
		const split = splitTerminalDocByKey(doc);
		expect(split.histories.get('')).toEqual(['out1']);
		expect(split.histories.get('tmux:@1')).toEqual(['in1', 'in2']);
		expect(split.pre.length).toBe(2);
	});

	it('applyCommandsToDoc to non-tmux key leaves tmux section untouched', () => {
		const doc = metaWithSections({ '': ['old'], 'tmux:@1': ['win-a'] });
		const out = applyCommandsToDoc(doc, ['fresh']);
		const split = splitTerminalDocByKey(out);
		expect(split.histories.get('')).toEqual(['fresh', 'old']);
		expect(split.histories.get('tmux:@1')).toEqual(['win-a']);
	});

	it('applyCommandsToDoc to tmux key leaves other buckets untouched', () => {
		const doc = metaWithSections({ '': ['out1'], 'tmux:@1': ['a'] });
		const out = applyCommandsToDoc(doc, ['b'], 'tmux:@1');
		const split = splitTerminalDocByKey(out);
		expect(split.histories.get('')).toEqual(['out1']);
		expect(split.histories.get('tmux:@1')).toEqual(['b', 'a']);
	});

	it('applyCommandsToDoc creates a new tmux section when missing', () => {
		const doc = metaWithSections({ '': ['outer'] });
		const out = applyCommandsToDoc(doc, ['htop'], 'tmux:@2');
		const split = splitTerminalDocByKey(out);
		expect(split.histories.get('')).toEqual(['outer']);
		expect(split.histories.get('tmux:@2')).toEqual(['htop']);
	});

	it('clearHistoryFromDoc on a single key drops only that section', () => {
		const doc = metaWithSections({ '': ['x'], 'tmux:@1': ['y'] });
		const out = clearHistoryFromDoc(doc, 'tmux:@1');
		const split = splitTerminalDocByKey(out);
		expect(split.histories.get('')).toEqual(['x']);
		expect(split.histories.has('tmux:@1')).toBe(false);
	});

	it('clearHistoryFromDoc default key drops the non-tmux section only', () => {
		const doc = metaWithSections({ '': ['x'], 'tmux:@1': ['y'] });
		const out = clearHistoryFromDoc(doc);
		const split = splitTerminalDocByKey(out);
		expect(split.histories.has('')).toBe(false);
		expect(split.histories.get('tmux:@1')).toEqual(['y']);
	});

	it('removeItemFromDoc removes from the targeted bucket only', () => {
		const doc = metaWithSections({ '': ['a', 'b'], 'tmux:@1': ['x'] });
		const out = removeItemFromDoc(doc, 0, 'tmux:@1');
		const split = splitTerminalDocByKey(out);
		expect(split.histories.get('')).toEqual(['a', 'b']);
		expect(split.histories.has('tmux:@1')).toBe(false); // emptied → header dropped
	});

	it('caps each bucket independently at 20', () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `cmd${i}`);
		let doc = metaWithSections({ '': twenty.slice() });
		doc = applyCommandsToDoc(doc, ['fresh-outer']);
		let split = splitTerminalDocByKey(doc);
		expect(split.histories.get('')?.length).toBe(20);
		expect(split.histories.get('')?.[0]).toBe('fresh-outer');

		doc = applyCommandsToDoc(doc, ['t1'], 'tmux:@1');
		split = splitTerminalDocByKey(doc);
		expect(split.histories.get('')?.length).toBe(20);
		expect(split.histories.get('tmux:@1')).toEqual(['t1']);
	});
});

// ── connect: section preservation tests ──────────────────────────────────────

import { parseTerminalNote } from '$lib/editor/terminal/parseTerminalNote.js';

function metaWithConnectAndHistory(connectItems: string[], historyItems: string[]): JSONContent {
	const blocks: JSONContent[] = [
		{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
		{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
		{ type: 'paragraph' },
		{ type: 'paragraph', content: [{ type: 'text', text: 'connect:' }] }
	];
	if (connectItems.length > 0) {
		blocks.push({
			type: 'bulletList',
			content: connectItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	if (historyItems.length > 0) {
		blocks.push({ type: 'paragraph' });
		blocks.push({ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] });
		blocks.push({
			type: 'bulletList',
			content: historyItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content: blocks };
}

describe('historyStore — connect section preservation', () => {
	it('applyCommandsToDoc preserves connect section', () => {
		const doc = metaWithConnectAndHistory(['t1', 't2'], ['a']);
		const out = applyCommandsToDoc(doc, ['NEW']);
		const spec = parseTerminalNote(out);
		expect(spec?.connect).toEqual(['t1', 't2']);
		expect(spec?.history).toEqual(['NEW', 'a']);
	});

	it('removeItemFromDoc preserves connect section', () => {
		const doc = metaWithConnectAndHistory(['t1', 't2'], ['a', 'b', 'c']);
		const out = removeItemFromDoc(doc, 1); // remove 'b'
		const spec = parseTerminalNote(out);
		expect(spec?.connect).toEqual(['t1', 't2']);
		expect(spec?.history).toEqual(['a', 'c']);
	});

	it('clearHistoryFromDoc preserves connect section', () => {
		const doc = metaWithConnectAndHistory(['t1', 't2'], ['a', 'b']);
		const out = clearHistoryFromDoc(doc);
		const spec = parseTerminalNote(out);
		expect(spec?.connect).toEqual(['t1', 't2']);
		expect(spec?.history).toEqual([]);
	});
});

// ── Pinned helpers ────────────────────────────────────────────────────────────

function metaWithPinnedAndHistory(
	pinnedItems: string[],
	historyItems: string[],
	windowKey?: string
): JSONContent {
	const blocks: JSONContent[] = [
		{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
		{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] }
	];
	if (pinnedItems.length > 0) {
		const pinnedHeader = windowKey ? `pinned:${windowKey}:` : 'pinned:';
		blocks.push({ type: 'paragraph' });
		blocks.push({ type: 'paragraph', content: [{ type: 'text', text: pinnedHeader }] });
		blocks.push({
			type: 'bulletList',
			content: pinnedItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	if (historyItems.length > 0) {
		const historyHeader = windowKey ? `history:${windowKey}:` : 'history:';
		blocks.push({ type: 'paragraph' });
		blocks.push({ type: 'paragraph', content: [{ type: 'text', text: historyHeader }] });
		blocks.push({
			type: 'bulletList',
			content: historyItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content: blocks };
}

describe('historyStore — pinned pure helpers', () => {
	it('pinCommandInDoc — pins a fresh command into empty pinned section', () => {
		const doc = metaDoc();
		const out = pinCommandInDoc(doc, 'htop');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['htop']);
		expect(spec?.histories.get('')).toBeUndefined();
	});

	it('pinCommandInDoc — moves command from history to pinned', () => {
		const doc = metaWithHistory(['htop', 'ls', 'pwd']);
		const out = pinCommandInDoc(doc, 'ls');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['ls']);
		expect(spec?.histories.get('')).toEqual(['htop', 'pwd']);
	});

	it('pinCommandInDoc — re-pinning moves to top of pinned', () => {
		const doc = metaWithPinnedAndHistory(['ls', 'htop'], []);
		const out = pinCommandInDoc(doc, 'htop');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['htop', 'ls']);
	});

	it('pinCommandInDoc — pinning is per-bucket (tmux:@1 vs non-tmux)', () => {
		const doc = metaWithHistory(['shared']);
		// pin in tmux:@1 bucket — non-tmux bucket untouched
		const out = pinCommandInDoc(doc, 'shared', 'tmux:@1');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('tmux:@1')).toEqual(['shared']);
		// non-tmux history should still have 'shared' (different bucket)
		expect(spec?.histories.get('')).toEqual(['shared']);
	});

	it('pinCommandInDoc — command not in history is still pinned (fresh)', () => {
		const doc = metaWithHistory(['ls']);
		const out = pinCommandInDoc(doc, 'df -h');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['df -h']);
		expect(spec?.histories.get('')).toEqual(['ls']);
	});

	it('unpinCommandInDoc — moves pinned back to top of history', () => {
		const doc = metaWithPinnedAndHistory(['htop'], ['ls', 'pwd']);
		const out = unpinCommandInDoc(doc, 'htop');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toBeUndefined();
		expect(spec?.histories.get('')).toEqual(['htop', 'ls', 'pwd']);
	});

	it('unpinCommandInDoc — no-op if not pinned', () => {
		const doc = metaWithPinnedAndHistory(['ls'], ['pwd']);
		const out = unpinCommandInDoc(doc, 'notpinned');
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['ls']);
		expect(spec?.histories.get('')).toEqual(['pwd']);
	});

	it('unpinCommandInDoc — unpin deduplicates in history (move-to-top)', () => {
		// 'htop' is also in history — unpin should move it to top, not duplicate
		const doc = metaWithPinnedAndHistory(['htop'], ['ls', 'htop', 'pwd']);
		const out = unpinCommandInDoc(doc, 'htop');
		const spec = parseTerminalNote(out);
		expect(spec?.histories.get('')).toEqual(['htop', 'ls', 'pwd']);
	});

	it('unpinCommandInDoc — unpin caps history at HISTORY_CAP (20)', () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `cmd${i}`);
		const doc = metaWithPinnedAndHistory(['extra'], twenty);
		const out = unpinCommandInDoc(doc, 'extra');
		const spec = parseTerminalNote(out);
		// move-to-top dedup: 'extra' not in twenty, so prepend + cap
		expect(spec?.histories.get('')?.length).toBe(20);
		expect(spec?.histories.get('')?.[0]).toBe('extra');
	});

	it('applyCommandsToDoc preserves pinned section', () => {
		const doc = metaWithPinnedAndHistory(['htop'], ['ls']);
		const out = applyCommandsToDoc(doc, ['pwd']);
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['htop']);
		expect(spec?.histories.get('')).toEqual(['pwd', 'ls']);
	});

	it('removeItemFromDoc preserves pinned section', () => {
		const doc = metaWithPinnedAndHistory(['htop'], ['ls', 'pwd']);
		const out = removeItemFromDoc(doc, 0); // remove 'ls'
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['htop']);
		expect(spec?.histories.get('')).toEqual(['pwd']);
	});

	it('clearHistoryFromDoc preserves pinned section', () => {
		const doc = metaWithPinnedAndHistory(['htop'], ['ls', 'pwd']);
		const out = clearHistoryFromDoc(doc);
		const spec = parseTerminalNote(out);
		expect(spec?.pinneds.get('')).toEqual(['htop']);
		expect(spec?.histories.get('')).toBeUndefined();
	});

	it('pinned has no cap — 30 pinned items all retained', () => {
		let doc = metaDoc();
		for (let i = 0; i < 30; i++) {
			doc = pinCommandInDoc(doc, `cmd${i}`);
		}
		const spec = parseTerminalNote(doc);
		expect(spec?.pinneds.get('')?.length).toBe(30);
	});
});

describe('historyStore — pinned IDB integration', () => {
	beforeEach(() => {
		globalThis.indexedDB = new IDBFactory();
		_resetDBForTest();
		_resetForTest();
	});

	it('pinCommandInTerminalHistory pins a command and removes from history', async () => {
		const guid = 'p1';
		await seedTerminalNote(guid, ['htop', 'ls', 'pwd']);
		await pinCommandInTerminalHistory(guid, 'ls');
		const after = await getNote(guid);
		const spec = parseTerminalNote(deserializeContent(after!.xmlContent));
		expect(spec?.pinneds.get('')).toEqual(['ls']);
		expect(spec?.histories.get('')).toEqual(['htop', 'pwd']);
	});

	it('unpinCommandInTerminalHistory moves pinned back to history', async () => {
		const guid = 'p2';
		const note = createEmptyNote(guid);
		note.title = 'Title';
		note.xmlContent = serializeContent(metaWithPinnedAndHistory(['htop'], ['ls']));
		await putNote(note);
		await unpinCommandInTerminalHistory(guid, 'htop');
		const after = await getNote(guid);
		const spec = parseTerminalNote(deserializeContent(after!.xmlContent));
		expect(spec?.pinneds.get('')).toBeUndefined();
		expect(spec?.histories.get('')).toEqual(['htop', 'ls']);
	});
});

import { deserializeContent } from '$lib/core/noteContentArchiver.js';
