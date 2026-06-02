import type { Editor } from '@tiptap/core';
import { InlineRadio } from './node.js';

export { InlineRadio };

export const TomboyInlineRadio = [InlineRadio];

/**
 * Alt+R 단축키 헬퍼 — 커서 위치에 미선택 라디오 atom 삽입.
 * 제목 줄(top-level idx 0)에서는 거부 (InputRule 의 제목 차단 정책과 동일).
 */
export function insertInlineRadio(editor: Editor): boolean {
	const { $from } = editor.state.selection;
	if ($from.depth < 1 || $from.index(0) === 0) return false;
	return editor
		.chain()
		.insertContent({ type: 'inlineRadio', attrs: { selected: false } })
		.run();
}
