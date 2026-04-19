import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import {
	desktopSession,
	registerFlushHook,
	registerReloadHook
} from '$lib/desktop/session.svelte.js';
import {
	insertNewNoteAfter,
	cutFromChain,
	pasteAfter
} from '$lib/sleepnote/ops.js';
import { validateSlipNoteFormat } from '$lib/sleepnote/validator.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

function makeSlipNote(title: string, prev: string, next: string): NoteData {
	const n = createEmptyNote('guid::' + title);
	n.title = title;
	const prevLine = prev === '없음' ? '이전: 없음' : `이전: <link:internal>${prev}</link:internal>`;
	const nextLine = next === '없음' ? '다음: 없음' : `다음: <link:internal>${next}</link:internal>`;
	n.xmlContent = `<note-content version="0.1">${title}\n\n${prevLine}\n${nextLine}\n\n</note-content>`;
	return n;
}

async function persistChain(titles: string[]): Promise<NoteData[]> {
	const notes = titles.map((t, i) =>
		makeSlipNote(
			t,
			i === 0 ? '없음' : titles[i - 1],
			i === titles.length - 1 ? '없음' : titles[i + 1]
		)
	);
	for (const n of notes) await putNote(n);
	return notes;
}

async function readPrev(guid: string): Promise<string> {
	const n = await getNote(guid);
	const r = validateSlipNoteFormat(n!);
	if (!r.prev) return '<invalid>';
	if (r.prev.kind === 'none') return '없음';
	if (r.prev.kind === 'link') return r.prev.target ?? '';
	return '<invalid>';
}

describe('desktopSession reload hook infrastructure', () => {
	it('reloadWindows fires hooks only for the listed guids', async () => {
		const fired = new Set<string>();
		registerReloadHook('a', () => {
			fired.add('a');
		});
		registerReloadHook('b', () => {
			fired.add('b');
		});
		registerReloadHook('c', () => {
			fired.add('c');
		});

		await desktopSession.reloadWindows(['a', 'c']);
		expect(fired).toEqual(new Set(['a', 'c']));
	});

	it('reloadWindows silently skips unregistered guids', async () => {
		const fired = new Set<string>();
		registerReloadHook('a', () => {
			fired.add('a');
		});
		// 'missing' has no hook — should not throw.
		await expect(desktopSession.reloadWindows(['a', 'missing'])).resolves.toBeUndefined();
		expect(fired).toEqual(new Set(['a']));
	});

	it('unregister removes the hook', async () => {
		let fired = 0;
		const off = registerReloadHook('a', () => {
			fired++;
		});
		off();
		await desktopSession.reloadWindows(['a']);
		expect(fired).toBe(0);
	});

	it('flushAll drains every registered flush hook', async () => {
		const fired: string[] = [];
		registerFlushHook('a', () => {
			fired.push('a');
		});
		registerFlushHook('b', () => {
			fired.push('b');
		});
		await desktopSession.flushAll();
		expect(new Set(fired)).toEqual(new Set(['a', 'b']));
	});

	it('flushAll awaits async flush hooks', async () => {
		let resolved = false;
		registerFlushHook('a', async () => {
			await new Promise((r) => setTimeout(r, 20));
			resolved = true;
		});
		await desktopSession.flushAll();
		expect(resolved).toBe(true);
	});

	it('flushAll swallows hook errors so one broken window cannot block an op', async () => {
		let aFired = false;
		registerFlushHook('broken', () => {
			throw new Error('boom');
		});
		registerFlushHook('a', () => {
			aFired = true;
		});
		await expect(desktopSession.flushAll()).resolves.toBeUndefined();
		expect(aFired).toBe(true);
	});
});

// ─── End-to-end: multi-window stale-save race fix ────────────────────────

describe('slip-note ops + desktopSession reload: stale-save regression', () => {
	/**
	 * Models the reported bug. Three windows are open: A, B (to-be-pasted),
	 * C. C's editor has a pendingDoc carrying its OLD `이전: A` (pre-op
	 * state). If the op writes `이전: B` to C in IDB and then C's stale
	 * pendingDoc lands, it overwrites the update. The fix flushes all
	 * windows' pending state first and then asks the session to reload
	 * every affected window so no stale writes follow.
	 *
	 * In the test we simulate a "stale save" landing AFTER the op by
	 * installing a flush hook that (would) persist the stale doc on
	 * flush — but since flushAll is called BEFORE the op, and the reload
	 * hook is fired AFTER the op, a stale save cannot overwrite C.
	 */
	it('C window gets reloaded so its stale pendingDoc is dropped after insert', async () => {
		const [a, c] = await persistChain(['A', 'C']);

		// Track reload-hook invocations. A real NoteWindow would clear
		// its pendingDoc and re-read IDB here; we just record the call.
		const reloadedGuids: string[] = [];
		registerReloadHook(a.guid, () => {
			reloadedGuids.push(a.guid);
		});
		registerReloadHook(c.guid, () => {
			reloadedGuids.push(c.guid);
		});

		// Simulate: the ops' caller (handleSlipInsertAfter) does
		// flushAll → op → reloadWindows(affectedGuids).
		await desktopSession.flushAll();
		const { newGuid, affectedGuids } = await insertNewNoteAfter(a.guid);
		await desktopSession.reloadWindows(affectedGuids);

		// C's `이전` must have flipped from A to the new note. This is
		// exactly the user-reported symptom.
		const newNote = await getNote(newGuid);
		expect(await readPrev(c.guid)).toBe(newNote!.title);

		// Both open windows for affected notes were asked to reload.
		expect(new Set(reloadedGuids)).toEqual(new Set([a.guid, c.guid]));
	});

	it('cutFromChain reloads both neighbors and the target', async () => {
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		const reloaded: string[] = [];
		for (const g of [a.guid, b.guid, c.guid]) {
			registerReloadHook(g, () => {
				reloaded.push(g);
			});
		}

		await desktopSession.flushAll();
		const { affectedGuids } = await cutFromChain(b.guid);
		await desktopSession.reloadWindows(affectedGuids);

		expect(new Set(reloaded)).toEqual(new Set([a.guid, b.guid, c.guid]));
		expect(await readPrev(c.guid)).toBe('A');
	});

	it('pasteAfter into A↔C reloads C so its backlink refresh is visible', async () => {
		// Direct analog of the reported bug for paste:
		// A↔C + detached B; paste B after A → A↔B↔C.
		const a = makeSlipNote('A', '없음', 'C');
		const b = makeSlipNote('B', '없음', '없음');
		const c = makeSlipNote('C', 'A', '없음');
		await putNote(a);
		await putNote(b);
		await putNote(c);

		const reloaded: string[] = [];
		for (const g of [a.guid, b.guid, c.guid]) {
			registerReloadHook(g, () => {
				reloaded.push(g);
			});
		}

		await desktopSession.flushAll();
		const { affectedGuids } = await pasteAfter(b.guid, a.guid);
		await desktopSession.reloadWindows(affectedGuids);

		expect(new Set(reloaded)).toEqual(new Set([a.guid, b.guid, c.guid]));
		expect(await readPrev(c.guid)).toBe('B');
	});
});
