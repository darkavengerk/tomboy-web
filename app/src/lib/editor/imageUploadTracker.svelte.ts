import { SvelteMap } from 'svelte/reactivity';
import type { Editor } from '@tiptap/core';

/**
 * 에디터별 진행 중 이미지 업로드 카운터.
 *
 * 붙여넣기 업로드(uploadAndInsertImage)는 fire-and-forget이고 URL 노드는
 * 업로드가 끝나야 doc에 삽입된다. 그 사이 ChatSendBar가 전송하면 이미지
 * 없는 요청이 나간다(paste→send 레이스). 이 카운터로 전송 게이트가
 * 업로드 완료를 기다린다. SvelteMap이라 $derived에서 반응형으로 읽힘.
 */
const counts = new SvelteMap<Editor, number>();

export function beginImageUpload(editor: Editor): void {
	counts.set(editor, (counts.get(editor) ?? 0) + 1);
}

export function endImageUpload(editor: Editor): void {
	const n = (counts.get(editor) ?? 0) - 1;
	if (n <= 0) counts.delete(editor);
	else counts.set(editor, n);
}

export function pendingImageUploads(editor: Editor): number {
	return counts.get(editor) ?? 0;
}
