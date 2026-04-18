import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import {
	getNote,
	getNoteEditorContent,
	updateNoteFromEditor
} from '$lib/core/noteManager.js';
import { pushToast } from '$lib/stores/toast.js';

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

/**
 * Transfer a list item from the source editor to the destination note.
 *
 * Ordering: destination is written first; only on success is the source li
 * removed. If the source doc has changed in the narrow async window such that
 * the node at `liPos` is no longer the expected li, the source is left alone.
 */
export async function transferListItem(
	sourceEditor: Editor,
	liPos: number,
	liNode: PMNode
): Promise<void> {
	const liJson = liNode.toJSON();
	const originalFingerprint = JSON.stringify(liJson);
	const expectedSize = liNode.nodeSize;

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

	const current = sourceEditor.state.doc.nodeAt(liPos);
	const stillMatches =
		current &&
		current.type.name === 'listItem' &&
		JSON.stringify(current.toJSON()) === originalFingerprint;
	if (stillMatches) {
		const tr = sourceEditor.state.tr.delete(liPos, liPos + expectedSize);
		sourceEditor.view.dispatch(tr);
		pushToast('보냈습니다.');
	} else {
		pushToast('보냈습니다. 원본 위치가 바뀌어 수동으로 정리하세요.', {
			kind: 'error'
		});
	}
}
