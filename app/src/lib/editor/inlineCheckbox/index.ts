import type { Editor } from '@tiptap/core';
import { InlineCheckbox } from './node.js';

export { InlineCheckbox };

export const TomboyInlineCheckbox = [InlineCheckbox];

/**
 * Alt+C 단축키 헬퍼 — 커서 위치에 미체크 체크박스 atom 삽입.
 * 제목 줄(top-level idx 0)에서는 거부 (InputRule 의 제목 차단 정책과 동일).
 */
export function insertInlineCheckbox(editor: Editor): boolean {
	const { $from } = editor.state.selection;
	if ($from.depth < 1 || $from.index(0) === 0) return false;
	return editor
		.chain()
		.insertContent({ type: 'inlineCheckbox', attrs: { checked: false } })
		.run();
}
