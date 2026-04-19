/**
 * Title-uniqueness guard helpers.
 *
 * Used in two places:
 *   1. Editor blur validator (TomboyEditor.svelte) — warns the user when the
 *      first-block text they just typed collides with another existing note.
 *   2. Save path defensive guard (noteManager.updateNoteFromEditor) — refuses
 *      the write silently if the title somehow still collides at save time.
 *
 * Case-sensitive throughout — matches lookupGuidByTitle's semantics.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
	lookupGuidByTitle,
	ensureTitleIndexReady
} from './autoLink/titleProvider.js';

export interface TitleConflict {
	conflict: boolean;
	existingGuid: string | null;
}

/**
 * Check whether `title` is already taken by a note OTHER than `selfGuid`.
 *
 * Trims the input before lookup; blank / whitespace titles never conflict.
 * Assumes the title index is already warm — callers that aren't sure should
 * `await ensureTitleIndexReady()` first.
 */
export function checkTitleConflict(
	title: string,
	selfGuid: string | null
): TitleConflict {
	const trimmed = title.trim();
	if (!trimmed) return { conflict: false, existingGuid: null };
	const hit = lookupGuidByTitle(trimmed);
	if (!hit) return { conflict: false, existingGuid: null };
	if (selfGuid && hit === selfGuid) return { conflict: false, existingGuid: null };
	return { conflict: true, existingGuid: hit };
}

/**
 * True iff a document position lies inside the first top-level block — the
 * "title line" in Tomboy's layout. Returns false (without throwing) for
 * out-of-range positions so selection listeners can call this safely on any
 * transaction.
 */
export function isCursorInTitleBlock(doc: PMNode, pos: number): boolean {
	if (pos < 0 || pos > doc.content.size + 2) return false;
	try {
		return doc.resolve(pos).index(0) === 0;
	} catch {
		return false;
	}
}

/**
 * Position that puts the caret at the end of the title block's text content,
 * i.e. the last position still inside the first paragraph. Returns 0 for an
 * empty doc. For an empty first paragraph this returns 1 (inside the paragraph,
 * before its close token).
 */
export function titleEndPos(doc: PMNode): number {
	const first = doc.firstChild;
	if (!first) return 0;
	return first.nodeSize - 1;
}

/** Plain-text content of the first top-level block. `''` for an empty doc. */
export function extractTitleText(doc: PMNode): string {
	const first = doc.firstChild;
	if (!first) return '';
	return first.textContent;
}

/**
 * Mutable ref used to latch the last title that was reported as a conflict
 * — prevents the blur validator from re-toasting on every repeated blur with
 * the same still-colliding title.
 */
export interface LastConflictTitleRef {
	current: string | null;
}

/**
 * Blur-time title validator. Intended to be called from the editor's
 * `selectionUpdate` handler when the cursor transitions out of the title
 * block.
 *
 * Behaviour:
 *   - Awaits ensureTitleIndexReady so the lookup sees a warm index.
 *   - No conflict → clears the latch, returns `{ blocked: false }`. (No toast,
 *     no cursor move.)
 *   - Conflict with the SAME title already latched → still moves the cursor
 *     back to the title line (so the user can edit it) but does NOT toast a
 *     second time. Returns `{ blocked: true }`.
 *   - Conflict with a NEW title → toasts, sets the latch, moves the cursor to
 *     `titleEndPos`, focuses the editor. Returns `{ blocked: true }`.
 *
 * Pure in the sense that the toast sink and the latch are passed in — no
 * module-level state.
 */
export async function handleTitleBlur(
	editor: Editor,
	currentGuid: string | null,
	pushToast: (msg: string, opts?: { kind: 'error' | 'info' }) => void,
	lastConflictTitleRef: LastConflictTitleRef
): Promise<{ blocked: boolean }> {
	const rawTitle = extractTitleText(editor.state.doc);
	const title = rawTitle.trim();
	if (!title) {
		lastConflictTitleRef.current = null;
		return { blocked: false };
	}
	await ensureTitleIndexReady();
	const { conflict } = checkTitleConflict(title, currentGuid);
	if (!conflict) {
		lastConflictTitleRef.current = null;
		return { blocked: false };
	}

	const alreadyReported = lastConflictTitleRef.current === title;
	if (!alreadyReported) {
		lastConflictTitleRef.current = title;
		pushToast(
			`이미 "${title}" 이라는 제목의 노트가 있습니다. 제목을 수정해 주세요.`,
			{ kind: 'error' }
		);
	}

	const end = titleEndPos(editor.state.doc);
	editor.commands.setTextSelection(end);
	editor.commands.focus();
	return { blocked: true };
}
