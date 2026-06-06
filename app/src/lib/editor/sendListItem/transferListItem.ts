import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
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
	findMonthBulletList,
	parsePrefix,
	planMonthInsert,
	recurrenceFromParse,
	sortListItemsByDay,
	type MonthInsertPlan,
	type RecurrenceSpec
} from './recurringCopy.js';

/** GUID of the note whose list items get "보내기" buttons. */
export const SEND_SOURCE_GUID = 'd5ef5481-b301-44fa-bd50-aa5ce7b32cf2';

/** GUID of the note that receives sent list items (appended to its last list). */
export const SEND_TARGET_GUID = '1cc0670b-8a5c-4858-b6a1-a2f7b5c24103';

/**
 * Append `liJson` to the end of the last bulletList in `docJson`, then sort
 * that list by schedule day (undated items pinned in place). If the doc has no
 * bulletList, create one at the end containing just the new item.
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
		const items = sortListItemsByDay([...(list.content ?? []), liJson]);
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

	const lastList = findLastBulletList(state.doc);

	const tr = state.tr;
	if (lastList) {
		const insertPos = lastList.pos + lastList.node.nodeSize - 1;
		tr.insert(insertPos, liNode);
		// Re-find the (now larger) last list in tr.doc and day-sort it.
		const grown = findLastBulletList(tr.doc);
		if (grown) sortListNodeInTr(tr, schema, grown.pos, grown.node);
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

/** Find the last top-level bulletList in `doc` (offset + node), or null. */
function findLastBulletList(doc: PMNode): { pos: number; node: PMNode } | null {
	let result: { pos: number; node: PMNode } | null = null;
	doc.forEach((child, offset) => {
		if (child.type.name === 'bulletList') result = { pos: offset, node: child };
	});
	return result;
}

/**
 * Replace the list node at `listPos` with a day-sorted copy of its items
 * (undated items pinned in place), within `tr`. No-op if the order is already
 * sorted or the schema can't rebuild the node. `sortListItemsByDay` preserves
 * item object identity, so reference equality detects an unchanged order.
 */
function sortListNodeInTr(
	tr: Transaction,
	schema: Schema,
	listPos: number,
	listNode: PMNode
): void {
	const items: JSONContent[] = [];
	listNode.forEach((child) => items.push(child.toJSON()));
	const sorted = sortListItemsByDay(items);
	if (sorted.every((it, i) => it === items[i])) return;
	let newList: PMNode;
	try {
		newList = schema.nodeFromJSON({ type: listNode.type.name, content: sorted });
	} catch {
		return;
	}
	tr.replaceWith(listPos, listPos + listNode.nodeSize, newList);
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
export function applySourceSideEdits(
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
	// Set to the target month when the recurred copy went into an EXISTING list,
	// so we day-sort that list once the original li is gone.
	let sortMonth: number | null = null;

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
				// A freshly created section/list holds a single item — nothing to sort.
				if (plan.kind === 'append-to-list') sortMonth = target.month;
			}
		}
	}

	const mappedLiPos = tr.mapping.map(liPos);
	tr.delete(mappedLiPos, mappedLiPos + expectedSize);

	if (sortMonth !== null) {
		// Re-find the target month's list in the post-insert/delete doc and sort it.
		const list = findMonthBulletList(tr.doc, sortMonth);
		if (list) sortListNodeInTr(tr, state.schema, list.pos, list.node);
	}

	sourceEditor.view.dispatch(tr);
	return recurredSpec ? { status: 'recurred', spec: recurredSpec } : { status: 'sent' };
}

function recurredToastMessage(spec: RecurrenceSpec): string {
	if (spec.kind === 'monthly') return '보냈습니다. 다음 달에도 추가했어요.';
	if (spec.weeks === 1) return '보냈습니다. 다음 주에도 추가했어요.';
	return `보냈습니다. ${spec.weeks}주 뒤에도 추가했어요.`;
}

function skippedToastMessage(spec: RecurrenceSpec): string {
	if (spec.kind === 'monthly') return '건너뛰었습니다. 다음 달로 옮겼어요.';
	if (spec.weeks === 1) return '건너뛰었습니다. 다음 주로 옮겼어요.';
	return `건너뛰었습니다. ${spec.weeks}주 뒤로 옮겼어요.`;
}

/**
 * Skip a list item — like 보내기 but WITHOUT writing to the history note.
 *
 *   - 마커 없는 항목 → 그냥 삭제한다.
 *   - 반복 마커 있는 항목(`25*(수)` 월간 / `25(수**)` 주간) → 히스토리로 보내는
 *     단계만 건너뛰고, 다음 주기 날짜로 복제본을 옮긴다(원본 삭제 + 목표 월 섹션
 *     삽입). 보내기와 동일한 소스측 편집(`applySourceSideEdits`)을 재사용하되
 *     destination 쓰기만 생략하므로, 단일 트랜잭션 = 한 번의 Ctrl+Z로 되돌릴 수 있다.
 *
 * destination 쓰기가 없어 동기다 — 비동기 윈도우(원본 위치 변동) 자체가 없다.
 */
export function skipListItem(sourceEditor: Editor, liPos: number, liNode: PMNode): void {
	if (sourceEditor.isDestroyed) return;
	const originalFingerprint = JSON.stringify(liNode.toJSON());
	const expectedSize = liNode.nodeSize;
	const parsed = parsePrefix(liNode.firstChild?.textContent ?? '');
	const spec = parsed ? recurrenceFromParse(parsed) : null;

	const outcome = applySourceSideEdits(
		sourceEditor,
		liPos,
		originalFingerprint,
		expectedSize,
		spec
	);
	if (outcome.status === 'recurred') {
		pushToast(skippedToastMessage(outcome.spec));
	} else if (outcome.status === 'sent') {
		pushToast('삭제했습니다.');
	} else {
		pushToast('원본 위치가 바뀌어 건너뛰지 못했습니다. 수동으로 정리하세요.', {
			kind: 'error'
		});
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
 *   - `25(수*)` (주간 마커 N개) → everyNWeeks (+7N d, inserted into that month's section)
 * Label-only `*` (no day prefix) and plain items trigger no recurrence. Both
 * insertion lists (this month's section and the destination note) are day-sorted.
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
