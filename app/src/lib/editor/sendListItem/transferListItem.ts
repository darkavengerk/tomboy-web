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
	buildRecurredLiJson,
	computeTargetDate,
	findContainingMonth,
	parsePrefix,
	planMonthInsert,
	recurrenceFromParse,
	type MonthInsertPlan,
	type RecurrenceSpec
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
 * Build the ProseMirror nodes that realise `plan` for `targetMonth`. Returns
 * `null` if the schema cannot represent them (which would be a programmer
 * error — the schedule note ships with bulletList + paragraph as standard).
 */
function buildInsertionNodes(
	schema: Schema,
	plan: MonthInsertPlan,
	liJson: JSONContent,
	targetMonth: number
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
	const headerText = schema.text(`${targetMonth}월`);
	const header = paragraph.create(null, [headerText]);
	return [header, list];
}

type SourceEditOutcome =
	| { status: 'sent' }
	| { status: 'recurred'; spec: RecurrenceSpec }
	| { status: 'displaced' };

/**
 * 소스 쪽 편집(반복 복제본 삽입 + 원본 삭제)을 단일 트랜잭션으로 적용해 한 번의
 * Ctrl+Z로 되돌릴 수 있게 한다. spec이 있으면 항목에 적힌 날짜로 목표 날짜를
 * 계산해 해당 월 섹션에 복제본을 삽입한다.
 */
function applySourceSideEdits(
	sourceEditor: Editor,
	liPos: number,
	originalFingerprint: string,
	expectedSize: number,
	spec: RecurrenceSpec | null
): SourceEditOutcome {
	const { state } = sourceEditor;
	const current = state.doc.nodeAt(liPos);
	const stillMatches =
		current &&
		current.type.name === 'listItem' &&
		JSON.stringify(current.toJSON()) === originalFingerprint;
	if (!stillMatches) return { status: 'displaced' };

	const tr = state.tr;
	let recurredSpec: RecurrenceSpec | null = null;

	if (spec) {
		const baseMonth = findContainingMonth(state.doc, liPos);
		// Re-parse the live node for its day number. `current` is fingerprint-verified
		// against the captured node, so this matches the `spec` computed by the caller.
		const parsed = parsePrefix(current.firstChild?.textContent ?? '');
		if (baseMonth !== null && parsed) {
			const baseYear = new Date().getFullYear();
			const target = computeTargetDate(baseYear, baseMonth, parsed.day, spec);
			const liJson = buildRecurredLiJson(current.toJSON(), target);
			const plan = planMonthInsert(state.doc, target.month);
			const nodes = buildInsertionNodes(state.schema, plan, liJson, target.month);
			if (nodes) {
				const insertPos =
					plan.kind === 'new-section-at-end' ? state.doc.content.size : plan.insertPos;
				tr.insert(insertPos, nodes);
				recurredSpec = spec;
			}
		}
	}

	const mappedLiPos = tr.mapping.map(liPos);
	tr.delete(mappedLiPos, mappedLiPos + expectedSize);
	sourceEditor.view.dispatch(tr);
	return recurredSpec ? { status: 'recurred', spec: recurredSpec } : { status: 'sent' };
}

function recurredToastMessage(spec: RecurrenceSpec): string {
	switch (spec.kind) {
		case 'monthly':
			return '보냈습니다. 다음 달에도 추가했어요.';
		case 'weekly':
			return '보냈습니다. 다음 주에도 추가했어요.';
		case 'everyNWeeks':
			return `보냈습니다. ${spec.weeks}주 뒤에도 추가했어요.`;
	}
}

/**
 * Transfer a list item from the source editor to the destination note.
 *
 * Ordering: destination is written first; only on success is the source li
 * removed. If the source doc has changed in the narrow async window such that
 * the node at `liPos` is no longer the expected li, the source is left alone.
 *
 * Recurring extension: the marker POSITION decides the recurrence kind:
 *   - `25*(수)` (월간 마커) → monthly (same day, month+1)
 *   - `25(수)*` (주간 마커) → weekly (+7d, inserted into that month's section)
 *   - `25(수)^N` (N주 마커) → everyNWeeks (+7N d, inserted into that month's section)
 * Label-only `*` (no day prefix) and plain items trigger no recurrence.
 */
export async function transferListItem(
	sourceEditor: Editor,
	liPos: number,
	liNode: PMNode
): Promise<void> {
	const liJson = liNode.toJSON();
	const originalFingerprint = JSON.stringify(liJson);
	const expectedSize = liNode.nodeSize;
	const parsed = parsePrefix(liNode.firstChild?.textContent ?? '');
	const spec = parsed ? recurrenceFromParse(parsed) : null;

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
		spec
	);
	if (outcome.status === 'recurred') {
		pushToast(recurredToastMessage(outcome.spec));
	} else if (outcome.status === 'sent') {
		pushToast('보냈습니다.');
	} else {
		pushToast('보냈습니다. 원본 위치가 바뀌어 수동으로 정리하세요.', {
			kind: 'error'
		});
	}
}
