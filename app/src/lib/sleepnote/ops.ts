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
import { ensureUniqueTitle, formatDateTimeTitle } from '$lib/core/noteManager.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import { SLIPBOX_NOTEBOOK, validateSlipNoteFormat, type SlipField } from './validator.js';

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
 *
 * `affectedGuids` lists every note whose xmlContent was written, so the
 * caller can force-reload open windows on those notes — otherwise a stale
 * editor in another window would overwrite the op's update on its next
 * debounced save.
 */
export async function insertNewNoteAfter(
	currentGuid: string
): Promise<{ newGuid: string; newTitle: string; affectedGuids: string[] }> {
	const current = await mustGet(currentGuid);
	const cur = mustBeValidSlipNote(current);

	// Pre-resolve the old successor so a broken chain fails the whole op
	// before any writes land.
	let oldNext: NoteData | undefined;
	if (cur.next.kind === 'link') {
		oldNext = await mustGetByTitle(cur.next.target ?? '');
		mustBeValidSlipNote(oldNext);
	}

	const newTitle = await ensureUniqueTitle(formatDateTimeTitle(new Date()));
	const newGuid = generateGuid();
	const newNote = createEmptyNote(newGuid);
	newNote.title = newTitle;
	newNote.tags = [`system:notebook:${SLIPBOX_NOTEBOOK}`];
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

	const affectedGuids: string[] = [newGuid, currentGuid];

	if (oldNext) {
		const oldNextFields = mustBeValidSlipNote(oldNext);
		const oldNextUpdated = withUpdatedFields(
			oldNext,
			{ kind: 'link', target: newTitle },
			oldNextFields.next
		);
		await noteStore.putNote(oldNextUpdated);
		affectedGuids.push(oldNext.guid);
	}

	invalidateCache();
	return { newGuid, newTitle, affectedGuids };
}

/**
 * Remove `guid` from its chain, splicing neighbors together and leaving
 * the target detached (prev=없음, next=없음). Safe to call on a detached
 * note; a no-op that still bumps the changeDate would be wasteful so this
 * function short-circuits when there are no links to touch.
 *
 * `affectedGuids` lists every note written (target + any spliced
 * neighbors). Empty when the target was already detached.
 */
export async function cutFromChain(
	guid: string
): Promise<{ affectedGuids: string[] }> {
	const target = await mustGet(guid);
	const tf = mustBeValidSlipNote(target);

	// Nothing to cut.
	if (tf.prev.kind === 'none' && tf.next.kind === 'none') return { affectedGuids: [] };

	let prevNeighbor: NoteData | undefined;
	let nextNeighbor: NoteData | undefined;
	if (tf.prev.kind === 'link') {
		prevNeighbor = await mustGetByTitle(tf.prev.target ?? '');
	}
	if (tf.next.kind === 'link') {
		nextNeighbor = await mustGetByTitle(tf.next.target ?? '');
	}

	const affectedGuids: string[] = [];

	if (prevNeighbor) {
		const fields = mustBeValidSlipNote(prevNeighbor);
		await noteStore.putNote(
			withUpdatedFields(prevNeighbor, fields.prev, tf.next)
		);
		affectedGuids.push(prevNeighbor.guid);
	}
	if (nextNeighbor) {
		const fields = mustBeValidSlipNote(nextNeighbor);
		await noteStore.putNote(
			withUpdatedFields(nextNeighbor, tf.prev, fields.next)
		);
		affectedGuids.push(nextNeighbor.guid);
	}

	await noteStore.putNote(
		withUpdatedFields(target, { kind: 'none' }, { kind: 'none' })
	);
	affectedGuids.push(guid);

	invalidateCache();
	return { affectedGuids };
}

/**
 * Insert `pastedGuid` into the chain directly after `targetGuid`. If the
 * pasted note is still attached to another chain, it's spliced out first.
 * If the pasted note is already the immediate successor of target, nothing
 * is written.
 *
 * `affectedGuids` aggregates writes from the optional inner cut AND the
 * paste itself, so a single `reloadWindows(affectedGuids)` call covers
 * every note a caller should refresh.
 */
export async function pasteAfter(
	pastedGuid: string,
	targetGuid: string
): Promise<{ affectedGuids: string[] }> {
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
		return { affectedGuids: [] };
	}

	const affected = new Set<string>();

	// Detach pasted from its current chain if it's still linked.
	if (pfInitial.prev.kind === 'link' || pfInitial.next.kind === 'link') {
		const cutResult = await cutFromChain(pastedGuid);
		for (const g of cutResult.affectedGuids) affected.add(g);
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
	affected.add(targetGuid);

	await noteStore.putNote(
		withUpdatedFields(
			pasted,
			{ kind: 'link', target: target.title },
			tf.next
		)
	);
	affected.add(pastedGuid);

	if (oldNextOfTarget) {
		const ff = mustBeValidSlipNote(oldNextOfTarget);
		await noteStore.putNote(
			withUpdatedFields(
				oldNextOfTarget,
				{ kind: 'link', target: pasted.title },
				ff.next
			)
		);
		affected.add(oldNextOfTarget.guid);
	}

	invalidateCache();
	return { affectedGuids: [...affected] };
}

/**
 * Detach `guid` from its previous neighbor only. Unlike `cutFromChain`,
 * the target keeps its `다음` link and the whole downstream chain stays
 * intact — the target simply becomes a new HEAD of that chain.
 *
 * Backs the "다른 곳에 연결" icon's phase-1: the user expects the chain
 * beneath the target to travel with it.
 *
 * No-op when the target is already a HEAD (이전 = 없음); returns an
 * empty `affectedGuids` so callers can tell nothing was written.
 */
export async function disconnectFromPrev(
	guid: string
): Promise<{ affectedGuids: string[] }> {
	const target = await mustGet(guid);
	const tf = mustBeValidSlipNote(target);

	if (tf.prev.kind === 'none') return { affectedGuids: [] };

	const prevNeighbor = await mustGetByTitle(tf.prev.target ?? '');
	const pf = mustBeValidSlipNote(prevNeighbor);

	const affected: string[] = [];

	await noteStore.putNote(
		withUpdatedFields(prevNeighbor, pf.prev, { kind: 'none' })
	);
	affected.push(prevNeighbor.guid);

	await noteStore.putNote(
		withUpdatedFields(target, { kind: 'none' }, tf.next)
	);
	affected.push(guid);

	invalidateCache();
	return { affectedGuids: affected };
}

/**
 * Walk `source`'s downstream chain via `다음` links and return the set of
 * trimmed titles encountered (including `source` itself). Used by
 * `connectAfter` to detect loops. Stops silently on an invalid / broken
 * intermediate — a broken downstream is not this op's concern; the
 * important guarantee is that no title we'd visit matches the target.
 */
async function collectDownstreamTitles(source: NoteData): Promise<Set<string>> {
	const titles = new Set<string>([source.title.trim()]);
	const seenGuids = new Set<string>([source.guid]);
	let cur: NoteData = source;
	while (true) {
		const r = validateSlipNoteFormat(cur);
		if (r.issues.length > 0) break;
		if (!r.next || r.next.kind !== 'link') break;
		const next = await noteStore.findNoteByTitle(r.next.target ?? '');
		if (!next || next.deleted) break;
		if (seenGuids.has(next.guid)) break;
		seenGuids.add(next.guid);
		titles.add(next.title.trim());
		cur = next;
	}
	return titles;
}

/**
 * Attach `source` (and its entire downstream chain) immediately after
 * `target`. Backs the "다른 곳에 연결" icon's phase-2 (paste).
 *
 * Preconditions (all throw on violation — no partial writes):
 *   • source ≠ target
 *   • both notes have valid slip-note format
 *   • target is a TAIL (다음 = 없음) — otherwise the target's existing
 *     successor would be orphaned
 *   • source is a HEAD (이전 = 없음) — caller is expected to have run
 *     `disconnectFromPrev(source)` first
 *   • target is NOT anywhere in source's downstream chain — connecting
 *     would create a loop
 *
 * Only the edge is written: `target.다음 = source` and
 * `source.이전 = target`. Source's downstream notes are never touched,
 * which is what makes this different from `pasteAfter` (that op splices
 * a single detached note into the middle of a chain).
 */
export async function connectAfter(
	sourceGuid: string,
	targetGuid: string
): Promise<{ affectedGuids: string[] }> {
	if (sourceGuid === targetGuid) {
		throw new Error('자기 자신에 연결할 수 없습니다');
	}

	const source = await mustGet(sourceGuid);
	const target = await mustGet(targetGuid);
	const sf = mustBeValidSlipNote(source);
	const tf = mustBeValidSlipNote(target);

	if (tf.next.kind === 'link') {
		throw new Error(
			`붙여넣을 노트("${target.title}")의 다음 링크가 이미 있어 연결할 수 없습니다 (TAIL이 아님)`
		);
	}
	if (sf.prev.kind === 'link') {
		throw new Error(
			`연결할 노트("${source.title}")의 이전 링크가 남아 있습니다 (HEAD이 아님)`
		);
	}

	const downstream = await collectDownstreamTitles(source);
	if (downstream.has(target.title.trim())) {
		throw new Error('연결하면 순환(loop)이 생깁니다');
	}

	await noteStore.putNote(
		withUpdatedFields(target, tf.prev, { kind: 'link', target: source.title })
	);
	await noteStore.putNote(
		withUpdatedFields(source, { kind: 'link', target: target.title }, sf.next)
	);

	invalidateCache();
	return { affectedGuids: [targetGuid, sourceGuid] };
}
