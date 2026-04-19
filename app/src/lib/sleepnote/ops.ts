/**
 * Slip-note chain operations: insert a new note after the current one,
 * cut a note out of its chain, and paste a detached note after a target.
 *
 * All operations read → mutate → persist through `noteStore`. They preserve
 * the linked-list invariants:
 *   - a note's `이전` link, if any, points to a note whose `다음` is this note;
 *   - a note's `다음` link, if any, points to a note whose `이전` is this note.
 *
 * Operations refuse to run on notes whose slip-format is already broken
 * (validated via `validateSlipNoteFormat`) to avoid compounding damage.
 */

import type { JSONContent } from '@tiptap/core';

import {
	createEmptyNote,
	escapeXml,
	formatTomboyDate,
	type NoteData
} from '$lib/core/note.js';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import { validateSlipNoteFormat, type SlipField } from './validator.js';
import { formatSlipNoteTitle } from './create.js';

interface FieldValue {
	kind: 'none' | 'link';
	target?: string;
}

function fieldToValue(f: SlipField | undefined): FieldValue {
	if (!f || f.kind !== 'link') return { kind: 'none' };
	return { kind: 'link', target: f.target };
}

function buildFieldParagraph(
	label: '이전' | '다음',
	value: FieldValue
): JSONContent {
	if (value.kind === 'none') {
		return { type: 'paragraph', content: [{ type: 'text', text: `${label}: 없음` }] };
	}
	const target = value.target ?? '';
	return {
		type: 'paragraph',
		content: [
			{ type: 'text', text: `${label}: ` },
			{
				type: 'text',
				text: target,
				marks: [{ type: 'tomboyInternalLink', attrs: { target } }]
			}
		]
	};
}

/** Returns a new NoteData with the given prev/next fields and bumped dates. */
function withUpdatedFields(
	note: NoteData,
	prev: FieldValue,
	next: FieldValue
): NoteData {
	const doc = deserializeContent(note.xmlContent);
	const blocks = (doc.content ?? []).slice();
	blocks[2] = buildFieldParagraph('이전', prev);
	blocks[3] = buildFieldParagraph('다음', next);
	const newDoc = { ...doc, content: blocks };
	const now = formatTomboyDate(new Date());
	return {
		...note,
		xmlContent: serializeContent(newDoc),
		changeDate: now,
		metadataChangeDate: now
	};
}

async function mustGet(guid: string): Promise<NoteData> {
	const n = await noteStore.getNote(guid);
	if (!n || n.deleted) throw new Error(`노트를 찾을 수 없습니다: ${guid}`);
	return n;
}

async function mustGetByTitle(title: string): Promise<NoteData> {
	const n = await noteStore.findNoteByTitle(title);
	if (!n || n.deleted) {
		throw new Error(`링크 대상 노트를 찾을 수 없습니다: "${title}"`);
	}
	return n;
}

function mustBeValidSlipNote(note: NoteData): {
	prev: FieldValue;
	next: FieldValue;
} {
	const r = validateSlipNoteFormat(note);
	if (r.issues.length > 0) {
		throw new Error(
			`슬립노트 형식이 올바르지 않습니다: "${note.title}" (${r.issues[0].code})`
		);
	}
	return { prev: fieldToValue(r.prev), next: fieldToValue(r.next) };
}

async function generateUniqueSlipTitle(baseDate: Date): Promise<string> {
	const base = formatSlipNoteTitle(baseDate);
	let candidate = base;
	let n = 2;
	while (await noteStore.findNoteByTitle(candidate)) {
		candidate = `${base} (${n})`;
		n++;
	}
	return candidate;
}

function buildNewSlipNoteXml(title: string, prev: FieldValue, next: FieldValue): string {
	const prevLine =
		prev.kind === 'link'
			? `<link:internal>${escapeXml(prev.target ?? '')}</link:internal>`
			: '없음';
	const nextLine =
		next.kind === 'link'
			? `<link:internal>${escapeXml(next.target ?? '')}</link:internal>`
			: '없음';
	return `<note-content version="0.1">${escapeXml(title)}\n\n이전: ${prevLine}\n다음: ${nextLine}\n\n</note-content>`;
}

// ─── Public ops ─────────────────────────────────────────────────────────

/**
 * Insert a brand-new slip-note immediately after `currentGuid` in the
 * chain. The new note inherits `current.다음` as its own `다음`, and
 * `current.다음` is rewritten to point at the new note. The old successor's
 * `이전` is updated to match.
 */
export async function insertNewNoteAfter(
	currentGuid: string
): Promise<{ newGuid: string; newTitle: string }> {
	const current = await mustGet(currentGuid);
	const cur = mustBeValidSlipNote(current);

	// Pre-resolve the old successor so a broken chain fails the whole op
	// before any writes land.
	let oldNext: NoteData | undefined;
	if (cur.next.kind === 'link') {
		oldNext = await mustGetByTitle(cur.next.target ?? '');
		mustBeValidSlipNote(oldNext);
	}

	const newTitle = await generateUniqueSlipTitle(new Date());
	const newGuid = generateGuid();
	const newNote = createEmptyNote(newGuid);
	newNote.title = newTitle;
	newNote.xmlContent = buildNewSlipNoteXml(
		newTitle,
		{ kind: 'link', target: current.title },
		cur.next.kind === 'link' ? { kind: 'link', target: cur.next.target } : { kind: 'none' }
	);

	await noteStore.putNote(newNote);

	const currentUpdated = withUpdatedFields(current, cur.prev, {
		kind: 'link',
		target: newTitle
	});
	await noteStore.putNote(currentUpdated);

	if (oldNext) {
		const oldNextFields = mustBeValidSlipNote(oldNext);
		const oldNextUpdated = withUpdatedFields(
			oldNext,
			{ kind: 'link', target: newTitle },
			oldNextFields.next
		);
		await noteStore.putNote(oldNextUpdated);
	}

	invalidateCache();
	return { newGuid, newTitle };
}

/**
 * Remove `guid` from its chain, splicing neighbors together and leaving
 * the target detached (prev=없음, next=없음). Safe to call on a detached
 * note; a no-op that still bumps the changeDate would be wasteful so this
 * function short-circuits when there are no links to touch.
 */
export async function cutFromChain(guid: string): Promise<void> {
	const target = await mustGet(guid);
	const tf = mustBeValidSlipNote(target);

	// Nothing to cut.
	if (tf.prev.kind === 'none' && tf.next.kind === 'none') return;

	let prevNeighbor: NoteData | undefined;
	let nextNeighbor: NoteData | undefined;
	if (tf.prev.kind === 'link') {
		prevNeighbor = await mustGetByTitle(tf.prev.target ?? '');
	}
	if (tf.next.kind === 'link') {
		nextNeighbor = await mustGetByTitle(tf.next.target ?? '');
	}

	if (prevNeighbor) {
		const fields = mustBeValidSlipNote(prevNeighbor);
		await noteStore.putNote(
			withUpdatedFields(prevNeighbor, fields.prev, tf.next)
		);
	}
	if (nextNeighbor) {
		const fields = mustBeValidSlipNote(nextNeighbor);
		await noteStore.putNote(
			withUpdatedFields(nextNeighbor, tf.prev, fields.next)
		);
	}

	await noteStore.putNote(
		withUpdatedFields(target, { kind: 'none' }, { kind: 'none' })
	);

	invalidateCache();
}

/**
 * Insert `pastedGuid` into the chain directly after `targetGuid`. If the
 * pasted note is still attached to another chain, it's spliced out first.
 * If the pasted note is already the immediate successor of target, nothing
 * is written.
 */
export async function pasteAfter(
	pastedGuid: string,
	targetGuid: string
): Promise<void> {
	if (pastedGuid === targetGuid) {
		throw new Error('자기 자신 뒤에 붙여넣을 수 없습니다');
	}

	const pastedInitial = await mustGet(pastedGuid);
	const targetInitial = await mustGet(targetGuid);
	const pfInitial = mustBeValidSlipNote(pastedInitial);
	const tfInitial = mustBeValidSlipNote(targetInitial);

	// Fast path: already positioned. Covers both "pasted is target's direct
	// successor" and "target's next link is already pasted".
	const titlesMatch = (a: string | undefined, b: string | undefined) =>
		(a ?? '').trim() === (b ?? '').trim();
	if (
		tfInitial.next.kind === 'link' &&
		titlesMatch(tfInitial.next.target, pastedInitial.title) &&
		pfInitial.prev.kind === 'link' &&
		titlesMatch(pfInitial.prev.target, targetInitial.title)
	) {
		return;
	}

	// Detach pasted from its current chain if it's still linked.
	if (pfInitial.prev.kind === 'link' || pfInitial.next.kind === 'link') {
		await cutFromChain(pastedGuid);
	}

	// Re-read target and pasted; the cut above may have rewritten either.
	const target = await mustGet(targetGuid);
	const tf = mustBeValidSlipNote(target);
	const pasted = await mustGet(pastedGuid);
	mustBeValidSlipNote(pasted);

	// target's old successor (may have changed after the cut).
	let oldNextOfTarget: NoteData | undefined;
	if (tf.next.kind === 'link') {
		oldNextOfTarget = await mustGetByTitle(tf.next.target ?? '');
	}

	await noteStore.putNote(
		withUpdatedFields(target, tf.prev, { kind: 'link', target: pasted.title })
	);
	await noteStore.putNote(
		withUpdatedFields(
			pasted,
			{ kind: 'link', target: target.title },
			tf.next
		)
	);
	if (oldNextOfTarget) {
		const ff = mustBeValidSlipNote(oldNextOfTarget);
		await noteStore.putNote(
			withUpdatedFields(
				oldNextOfTarget,
				{ kind: 'link', target: pasted.title },
				ff.next
			)
		);
	}

	invalidateCache();
}
