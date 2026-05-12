import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import {
	getNote,
	getNoteEditorContent,
	updateNoteFromEditor
} from '$lib/core/noteManager.js';
import { pushToast } from '$lib/stores/toast.js';
import {
	buildNextMonthLiJson,
	containsRecurringMarker,
	findContainingMonth,
	nextMonthOf,
	planNextMonthInsert,
	type NextMonthInsertPlan
} from './recurringCopy.js';

/** GUID of the note whose list items get "보내기" buttons. */
export const SEND_SOURCE_GUID = 'd5ef5481-b301-44fa-bd50-aa5ce7b32cf2';

/** GUID of the note that receives sent list items (appended to its last list). */
export const SEND_TARGET_GUID = '1cc0670b-8a5c-4858-b6a1-a2f7b5c24103';

/**
 * Append `liJson` to the end of the last bulletList in `docJson`. If the doc
 * has no bulletList, create one at the end containing just the new item.
 *
 * Returns a new doc JSON — does not mutate the input.
 */
export function appendListItemToDocJson(
	docJson: JSONContent,
	liJson: JSONContent
): JSONContent {
	const content = [...(docJson.content ?? [])];
	let lastListIdx = -1;
	for (let i = content.length - 1; i >= 0; i--) {
		if (content[i]?.type === 'bulletList') {
			lastListIdx = i;
			break;
		}
	}
	if (lastListIdx >= 0) {
		const list = content[lastListIdx];
		const items = [...(list.content ?? []), liJson];
		content[lastListIdx] = { ...list, content: items };
	} else {
		content.push({ type: 'bulletList', content: [liJson] });
	}
	return { ...docJson, content };
}

/**
 * Append a list-item node to a live TipTap editor's last bulletList (or append
 * a new bulletList at the end if none exists). Returns true on success.
 */
function appendLiToLiveEditor(editor: Editor, liJson: JSONContent): boolean {
	const { state, schema } = editor;
	let liNode: PMNode;
	try {
		liNode = schema.nodeFromJSON(liJson);
	} catch {
		return false;
	}

	let lastListOffset = -1;
	let lastList: PMNode | null = null;
	state.doc.forEach((child, offset) => {
		if (child.type.name === 'bulletList') {
			lastListOffset = offset;
			lastList = child;
		}
	});

	const tr = state.tr;
	if (lastList && lastListOffset >= 0) {
		const insertPos = lastListOffset + (lastList as PMNode).nodeSize - 1;
		tr.insert(insertPos, liNode);
	} else {
		const ul = schema.nodes.bulletList.create(null, [liNode]);
		tr.insert(state.doc.content.size, ul);
	}
	editor.view.dispatch(tr);
	return true;
}

/**
 * Write the list-item JSON into the destination note. Uses the live editor if
 * the note is currently open in a desktop window, otherwise reads/writes IDB.
 *
 * Throws on failure so the caller can leave the source intact.
 */
async function writeToDestination(liJson: JSONContent): Promise<void> {
	const liveEditor = desktopSession.getEditorForGuid(SEND_TARGET_GUID);
	if (liveEditor && !liveEditor.isDestroyed) {
		const ok = appendLiToLiveEditor(liveEditor, liJson);
		if (!ok) throw new Error('대상 노트에 삽입할 수 없습니다.');
		return;
	}

	const note = await getNote(SEND_TARGET_GUID);
	if (!note) throw new Error('대상 노트를 찾을 수 없습니다.');
	const docJson = getNoteEditorContent(note);
	const nextDoc = appendListItemToDocJson(docJson, liJson);
	const updated = await updateNoteFromEditor(SEND_TARGET_GUID, nextDoc);
	if (!updated) throw new Error('대상 노트 저장에 실패했습니다.');
}

function buildSchemaNode(schema: Schema, json: JSONContent): PMNode | null {
	try {
		return schema.nodeFromJSON(json);
	} catch {
		return null;
	}
}

/**
 * Build the ProseMirror nodes that realise `plan` for `nextMonth`. Returns
 * `null` if the schema cannot represent them (which would be a programmer
 * error — the schedule note ships with bulletList + paragraph as standard).
 */
function buildInsertionNodes(
	schema: Schema,
	plan: NextMonthInsertPlan,
	liJson: JSONContent,
	nextMonth: number
): PMNode[] | null {
	const liNode = buildSchemaNode(schema, liJson);
	if (!liNode) return null;
	if (plan.kind === 'append-to-list') {
		return [liNode];
	}
	const bulletList = schema.nodes.bulletList;
	if (!bulletList) return null;
	const list = bulletList.create(null, [liNode]);
	if (plan.kind === 'new-list-after-header') {
		return [list];
	}
	const paragraph = schema.nodes.paragraph;
	if (!paragraph) return null;
	const headerText = schema.text(`${nextMonth}월`);
	const header = paragraph.create(null, [headerText]);
	return [header, list];
}

/**
 * Apply the source-side edits (next-month recurring copy + original delete) in
 * a single transaction so the user can undo with one Ctrl+Z. Returns the
 * action that the toast should announce.
 */
function applySourceSideEdits(
	sourceEditor: Editor,
	liPos: number,
	originalFingerprint: string,
	expectedSize: number,
	recurring: boolean
): 'sent' | 'sent-and-recurred' | 'displaced' {
	const { state } = sourceEditor;
	const current = state.doc.nodeAt(liPos);
	const stillMatches =
		current &&
		current.type.name === 'listItem' &&
		JSON.stringify(current.toJSON()) === originalFingerprint;
	if (!stillMatches) return 'displaced';

	const tr = state.tr;
	let didRecur = false;

	if (recurring) {
		const currentMonth = findContainingMonth(state.doc, liPos);
		if (currentMonth !== null) {
			const { month: nextMonth, yearOffset } = nextMonthOf(currentMonth);
			const year = new Date().getFullYear() + yearOffset;
			const liJson = buildNextMonthLiJson(current.toJSON(), year, nextMonth);
			const plan = planNextMonthInsert(state.doc, nextMonth);
			const nodes = buildInsertionNodes(state.schema, plan, liJson, nextMonth);
			if (nodes) {
				const insertPos =
					plan.kind === 'new-section-at-end' ? state.doc.content.size : plan.insertPos;
				tr.insert(insertPos, nodes);
				didRecur = true;
			}
		}
	}

	const mappedLiPos = tr.mapping.map(liPos);
	tr.delete(mappedLiPos, mappedLiPos + expectedSize);
	sourceEditor.view.dispatch(tr);
	return didRecur ? 'sent-and-recurred' : 'sent';
}

/**
 * Transfer a list item from the source editor to the destination note.
 *
 * Ordering: destination is written first; only on success is the source li
 * removed. If the source doc has changed in the narrow async window such that
 * the node at `liPos` is no longer the expected li, the source is left alone.
 *
 * Recurring extension: when the source li's text contains `*`, it is treated
 * as a monthly routine — a copy (with the same `*`) is also inserted into the
 * next month's section of the source note in the same transaction as the
 * original delete, so the routine reappears next month.
 */
export async function transferListItem(
	sourceEditor: Editor,
	liPos: number,
	liNode: PMNode
): Promise<void> {
	const liJson = liNode.toJSON();
	const originalFingerprint = JSON.stringify(liJson);
	const expectedSize = liNode.nodeSize;
	const recurring = containsRecurringMarker(liNode.textContent);

	try {
		await writeToDestination(liJson);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushToast(`보내기 실패: ${msg}`, { kind: 'error' });
		return;
	}

	if (sourceEditor.isDestroyed) {
		pushToast('보냈습니다.');
		return;
	}

	const outcome = applySourceSideEdits(
		sourceEditor,
		liPos,
		originalFingerprint,
		expectedSize,
		recurring
	);
	if (outcome === 'sent-and-recurred') {
		pushToast('보냈습니다. 다음 달에도 추가했어요.');
	} else if (outcome === 'sent') {
		pushToast('보냈습니다.');
	} else {
		pushToast('보냈습니다. 원본 위치가 바뀌어 수동으로 정리하세요.', {
			kind: 'error'
		});
	}
}
