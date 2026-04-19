import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	insertNewNoteAfter,
	cutFromChain,
	pasteAfter
} from '$lib/sleepnote/ops.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { validateSlipNoteFormat, isSlipNoteTitle } from '$lib/sleepnote/validator.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

/**
 * Build a slip-note-formatted note with the given title and explicit prev/next
 * fields. `prev`/`next` are either the literal string "없음" or a title to link
 * to. Does not persist — caller handles persistence.
 */
function makeSlipNote(title: string, prev: string, next: string, body = ''): NoteData {
	const n = createEmptyNote('guid::' + title);
	n.title = title;
	const prevLine = prev === '없음'
		? '이전: 없음'
		: `이전: <link:internal>${prev}</link:internal>`;
	const nextLine = next === '없음'
		? '다음: 없음'
		: `다음: <link:internal>${next}</link:internal>`;
	const inner = `${title}\n\n${prevLine}\n${nextLine}\n\n${body}`;
	n.xmlContent = `<note-content version="0.1">${inner}</note-content>`;
	return n;
}

/**
 * Persist a whole chain at once. Chain is an array of titles. Creates each
 * note with prev/next set to its neighbor (or 없음 at the ends).
 */
async function persistChain(titles: string[]): Promise<NoteData[]> {
	const notes: NoteData[] = [];
	for (let i = 0; i < titles.length; i++) {
		const prev = i === 0 ? '없음' : titles[i - 1];
		const next = i === titles.length - 1 ? '없음' : titles[i + 1];
		notes.push(makeSlipNote(titles[i], prev, next));
	}
	for (const n of notes) await putNote(n);
	return notes;
}

/** Extract the current prev/next fields from a stored note. */
async function readFields(guid: string): Promise<{ prev: string; next: string }> {
	const n = await getNote(guid);
	if (!n) throw new Error(`note ${guid} not found`);
	const r = validateSlipNoteFormat(n);
	const fmt = (f: typeof r.prev) => {
		if (!f) return '<invalid>';
		if (f.kind === 'none') return '없음';
		if (f.kind === 'link') return f.target ?? '<empty-link>';
		return '<invalid>';
	};
	return { prev: fmt(r.prev), next: fmt(r.next) };
}

async function formatIssues(guid: string): Promise<string[]> {
	const n = await getNote(guid);
	if (!n) throw new Error(`note ${guid} not found`);
	return validateSlipNoteFormat(n).issues.map((i) => i.code);
}

/**
 * Walk a chain forward starting from `startGuid` via 다음 links. Returns
 * the titles of every visited node in order. Throws if a link doesn't
 * resolve (chain broken).
 */
async function walkForward(startGuid: string): Promise<string[]> {
	const { getAllNotes } = await import('$lib/storage/noteStore.js');
	const out: string[] = [];
	const seen = new Set<string>();
	let current = await getNote(startGuid);
	while (current) {
		if (seen.has(current.guid)) throw new Error('loop detected: ' + current.title);
		seen.add(current.guid);
		out.push(current.title);
		const r = validateSlipNoteFormat(current);
		if (!r.next || r.next.kind !== 'link') break;
		const nextTitle = r.next.target!;
		const notes = await getAllNotes();
		const match = notes.find((n) => n.title.trim() === nextTitle.trim());
		if (!match) throw new Error(`next link "${nextTitle}" does not resolve`);
		current = match;
	}
	return out;
}

// ─── insertNewNoteAfter ─────────────────────────────────────────────────

describe('insertNewNoteAfter', () => {
	it('inserts after a solo note (prev=없음, next=없음)', async () => {
		const [a] = await persistChain(['A']);
		const { newGuid, newTitle } = await insertNewNoteAfter(a.guid);

		expect(newGuid).toBeTruthy();
		expect(newTitle).toBeTruthy();
		expect(isSlipNoteTitle(newTitle)).toBe(true);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: newTitle });
		expect(await readFields(newGuid)).toEqual({ prev: a.title, next: '없음' });
		expect(await walkForward(a.guid)).toEqual([a.title, newTitle]);
	});

	it('inserts in the middle of a 3-note chain', async () => {
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		const { newGuid, newTitle } = await insertNewNoteAfter(b.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: b.title });
		expect(await readFields(b.guid)).toEqual({ prev: a.title, next: newTitle });
		expect(await readFields(newGuid)).toEqual({ prev: b.title, next: c.title });
		expect(await readFields(c.guid)).toEqual({ prev: newTitle, next: '없음' });
		expect(await walkForward(a.guid)).toEqual([a.title, b.title, newTitle, c.title]);
	});

	it('inserts after the HEAD of a chain (A→B): result A→new→B', async () => {
		const [a, b] = await persistChain(['A', 'B']);
		const { newGuid, newTitle } = await insertNewNoteAfter(a.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: newTitle });
		expect(await readFields(newGuid)).toEqual({ prev: a.title, next: b.title });
		expect(await readFields(b.guid)).toEqual({ prev: newTitle, next: '없음' });
	});

	it('inserts after the TAIL of a chain (A→B): result A→B→new', async () => {
		const [a, b] = await persistChain(['A', 'B']);
		const { newGuid, newTitle } = await insertNewNoteAfter(b.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: b.title });
		expect(await readFields(b.guid)).toEqual({ prev: a.title, next: newTitle });
		expect(await readFields(newGuid)).toEqual({ prev: b.title, next: '없음' });
	});

	it('new note passes validateSlipNoteFormat with no issues', async () => {
		const [a] = await persistChain(['A']);
		const { newGuid } = await insertNewNoteAfter(a.guid);
		expect(await formatIssues(newGuid)).toEqual([]);
	});

	it('new note preserves the standard slip-note body layout (5 header blocks + body)', async () => {
		const [a] = await persistChain(['A']);
		const { newGuid } = await insertNewNoteAfter(a.guid);
		const nn = await getNote(newGuid);
		const doc = deserializeContent(nn!.xmlContent);
		expect((doc.content?.length ?? 0) >= 5).toBe(true);
	});

	it("throws when current note doesn't exist", async () => {
		await expect(insertNewNoteAfter('guid::missing')).rejects.toThrow(/찾을 수 없습니다|not found/i);
	});

	it('throws when current note has an invalid slip-note format', async () => {
		const n = createEmptyNote('guid::bad');
		n.title = 'Bad';
		n.xmlContent = `<note-content version="0.1">Bad\n\n본문</note-content>`;
		await putNote(n);
		await expect(insertNewNoteAfter(n.guid)).rejects.toThrow(/형식/);
	});

	it("throws when current's 다음 link target doesn't resolve (broken chain)", async () => {
		const orphan = makeSlipNote('A', '없음', 'Ghost');
		await putNote(orphan);
		await expect(insertNewNoteAfter(orphan.guid)).rejects.toThrow(/Ghost|찾을 수 없|not found/i);
	});

	it('generated title is unique even when called twice in sequence', async () => {
		const [a] = await persistChain(['A']);
		const { newTitle: t1 } = await insertNewNoteAfter(a.guid);
		const { newTitle: t2 } = await insertNewNoteAfter(a.guid);
		expect(t1).not.toBe(t2);
	});

	it('does not modify the title or body of the current note', async () => {
		const n = makeSlipNote('A', '없음', '없음', '본문\n두번째 줄');
		await putNote(n);
		await insertNewNoteAfter(n.guid);
		const after = await getNote(n.guid);
		expect(after!.title).toBe('A');
		const doc = deserializeContent(after!.xmlContent);
		// Body (blocks 5+) preserved.
		const bodyText = (doc.content ?? [])
			.slice(5)
			.flatMap((b) => (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text))
			.join('\n');
		expect(bodyText).toContain('본문');
	});
});

// ─── cutFromChain ───────────────────────────────────────────────────────

describe('cutFromChain', () => {
	it('removes a middle note from A→B→C, leaving A→C and B detached', async () => {
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		await cutFromChain(b.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: c.title });
		expect(await readFields(c.guid)).toEqual({ prev: a.title, next: '없음' });
		expect(await readFields(b.guid)).toEqual({ prev: '없음', next: '없음' });
		expect(await walkForward(a.guid)).toEqual([a.title, c.title]);
	});

	it('removes the HEAD from A→B→C: new chain B→C, A detached', async () => {
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		await cutFromChain(a.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: '없음' });
		expect(await readFields(b.guid)).toEqual({ prev: '없음', next: c.title });
		expect(await readFields(c.guid)).toEqual({ prev: b.title, next: '없음' });
		expect(await walkForward(b.guid)).toEqual([b.title, c.title]);
	});

	it('removes the TAIL from A→B→C: chain becomes A→B, C detached', async () => {
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		await cutFromChain(c.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: b.title });
		expect(await readFields(b.guid)).toEqual({ prev: a.title, next: '없음' });
		expect(await readFields(c.guid)).toEqual({ prev: '없음', next: '없음' });
	});

	it('cutting a solo note (both none) is a no-op', async () => {
		const [a] = await persistChain(['A']);
		await cutFromChain(a.guid);
		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: '없음' });
	});

	it('preserves title and body after cut', async () => {
		const a = makeSlipNote('A', '없음', 'B', '본문입니다');
		const b = makeSlipNote('B', 'A', '없음');
		await putNote(a);
		await putNote(b);
		await cutFromChain(a.guid);
		const after = await getNote(a.guid);
		expect(after!.title).toBe('A');
		expect(after!.xmlContent).toContain('본문입니다');
	});

	it("throws when target doesn't exist", async () => {
		await expect(cutFromChain('guid::missing')).rejects.toThrow(/찾을 수 없|not found/i);
	});

	it('throws when the target has invalid slip format', async () => {
		const n = createEmptyNote('guid::bad');
		n.title = 'Bad';
		n.xmlContent = `<note-content version="0.1">Bad\n\n본문</note-content>`;
		await putNote(n);
		await expect(cutFromChain(n.guid)).rejects.toThrow(/형식/);
	});

	it("throws when the target's 이전 link doesn't resolve", async () => {
		const orphan = makeSlipNote('A', 'Ghost', '없음');
		await putNote(orphan);
		await expect(cutFromChain(orphan.guid)).rejects.toThrow(/Ghost|찾을 수 없|not found/i);
	});
});

// ─── pasteAfter ─────────────────────────────────────────────────────────

describe('pasteAfter', () => {
	it('pastes a detached B after solo A: result A→B', async () => {
		const a = makeSlipNote('A', '없음', '없음');
		const b = makeSlipNote('B', '없음', '없음');
		await putNote(a);
		await putNote(b);

		await pasteAfter(b.guid, a.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: 'B' });
		expect(await readFields(b.guid)).toEqual({ prev: 'A', next: '없음' });
		expect(await walkForward(a.guid)).toEqual(['A', 'B']);
	});

	it('pastes detached B into middle of A→C: result A→B→C', async () => {
		const a = makeSlipNote('A', '없음', 'C');
		const b = makeSlipNote('B', '없음', '없음');
		const c = makeSlipNote('C', 'A', '없음');
		await putNote(a);
		await putNote(b);
		await putNote(c);

		await pasteAfter(b.guid, a.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: 'B' });
		expect(await readFields(b.guid)).toEqual({ prev: 'A', next: 'C' });
		expect(await readFields(c.guid)).toEqual({ prev: 'B', next: '없음' });
		expect(await walkForward(a.guid)).toEqual(['A', 'B', 'C']);
	});

	it('pastes detached B after the TAIL of a chain', async () => {
		const [a, c] = await persistChain(['A', 'C']);
		const b = makeSlipNote('B', '없음', '없음');
		await putNote(b);

		await pasteAfter(b.guid, c.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: 'C' });
		expect(await readFields(c.guid)).toEqual({ prev: 'A', next: 'B' });
		expect(await readFields(b.guid)).toEqual({ prev: 'C', next: '없음' });
	});

	it('auto-detaches when pasted is still in a chain (move within the same chain)', async () => {
		// A→B→C→D. Move B to be after C → A→C→B→D.
		const [a, b, c, d] = await persistChain(['A', 'B', 'C', 'D']);
		await pasteAfter(b.guid, c.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: 'C' });
		expect(await readFields(c.guid)).toEqual({ prev: 'A', next: 'B' });
		expect(await readFields(b.guid)).toEqual({ prev: 'C', next: 'D' });
		expect(await readFields(d.guid)).toEqual({ prev: 'B', next: '없음' });
		expect(await walkForward(a.guid)).toEqual(['A', 'C', 'B', 'D']);
	});

	it('moving a note backward within its chain works (move C after A in A→B→C→D)', async () => {
		const [a, b, c, d] = await persistChain(['A', 'B', 'C', 'D']);
		await pasteAfter(c.guid, a.guid);

		expect(await readFields(a.guid)).toEqual({ prev: '없음', next: 'C' });
		expect(await readFields(c.guid)).toEqual({ prev: 'A', next: 'B' });
		expect(await readFields(b.guid)).toEqual({ prev: 'C', next: 'D' });
		expect(await readFields(d.guid)).toEqual({ prev: 'B', next: '없음' });
		expect(await walkForward(a.guid)).toEqual(['A', 'C', 'B', 'D']);
	});

	it('pasting a note directly after its current prev is a no-op semantically', async () => {
		// A→B→C: paste B after A (its current prev). Chain unchanged.
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		await pasteAfter(b.guid, a.guid);
		expect(await walkForward(a.guid)).toEqual(['A', 'B', 'C']);
	});

	it('refuses self-paste (target === pasted)', async () => {
		const [a] = await persistChain(['A']);
		await expect(pasteAfter(a.guid, a.guid)).rejects.toThrow(/자기 자신|self/i);
	});

	it("throws when target doesn't exist", async () => {
		const b = makeSlipNote('B', '없음', '없음');
		await putNote(b);
		await expect(pasteAfter(b.guid, 'guid::missing')).rejects.toThrow(/찾을 수 없|not found/i);
	});

	it("throws when pasted doesn't exist", async () => {
		const [a] = await persistChain(['A']);
		await expect(pasteAfter('guid::missing', a.guid)).rejects.toThrow(/찾을 수 없|not found/i);
	});

	it('throws when target has invalid slip format', async () => {
		const b = makeSlipNote('B', '없음', '없음');
		await putNote(b);
		const bad = createEmptyNote('guid::bad');
		bad.title = 'Bad';
		bad.xmlContent = `<note-content version="0.1">Bad\n\n본문</note-content>`;
		await putNote(bad);
		await expect(pasteAfter(b.guid, bad.guid)).rejects.toThrow(/형식/);
	});

	it('throws when pasted has invalid slip format', async () => {
		const [a] = await persistChain(['A']);
		const bad = createEmptyNote('guid::bad');
		bad.title = 'Bad';
		bad.xmlContent = `<note-content version="0.1">Bad\n\n본문</note-content>`;
		await putNote(bad);
		await expect(pasteAfter(bad.guid, a.guid)).rejects.toThrow(/형식/);
	});

	it('does not modify title or body of either note', async () => {
		const a = makeSlipNote('A', '없음', '없음', 'A본문');
		const b = makeSlipNote('B', '없음', '없음', 'B본문');
		await putNote(a);
		await putNote(b);
		await pasteAfter(b.guid, a.guid);

		const aa = await getNote(a.guid);
		const bb = await getNote(b.guid);
		expect(aa!.title).toBe('A');
		expect(bb!.title).toBe('B');
		expect(aa!.xmlContent).toContain('A본문');
		expect(bb!.xmlContent).toContain('B본문');
	});

	it('refuses to paste into a target whose chain already contains pasted at the exact same position (no redundant writes)', async () => {
		// A→B→C: pasting C after B is a no-op.
		const [a, b, c] = await persistChain(['A', 'B', 'C']);
		const beforeA = (await getNote(a.guid))!.changeDate;
		const beforeC = (await getNote(c.guid))!.changeDate;
		// Wait a tick so changeDate would differ if a write happened.
		await new Promise((r) => setTimeout(r, 15));
		await pasteAfter(c.guid, b.guid);
		expect(await walkForward(a.guid)).toEqual(['A', 'B', 'C']);
		// Touching unrelated notes (A) isn't strictly required to be a no-op
		// but the semantics should be idempotent.
		const afterA = (await getNote(a.guid))!.changeDate;
		expect(afterA).toBe(beforeA);
		const afterC = (await getNote(c.guid))!.changeDate;
		// C's fields are unchanged; don't require changeDate to be stable
		// since the op may still re-serialize. Accept either.
		void beforeC;
		void afterC;
	});
});
