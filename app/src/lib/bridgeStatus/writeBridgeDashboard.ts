import type { EditorView } from '@tiptap/pm/view';
import { buildBridgeDashboardNodes } from './buildBridgeDashboard.js';
import type { BridgeStatus } from './statusClient.js';

/**
 * 제목(첫 노드)은 두고, 그 아래 본문 전체를 새 대시보드로 교체(스냅샷).
 *
 * `from = 첫 노드 뒤`(musicExtractNotePlugin 의 afterTitlePos 와 동일),
 * `to = 문서 끝`. 매 ⟳ 마다 호출 → 멱등. 제목은 절대 건드리지 않는다.
 */
export function writeBridgeDashboard(view: EditorView, status: BridgeStatus): boolean {
	if (view.isDestroyed) return false;
	const { state } = view;
	const { schema, doc } = state;
	if (!schema.nodes.paragraph) return false;
	const first = doc.firstChild;
	if (!first) return false;

	const nodes = buildBridgeDashboardNodes(schema, status);
	if (nodes.length === 0) return false;

	const from = first.nodeSize; // 제목 노드 바로 뒤
	const to = doc.content.size;
	const tr = state.tr.replaceWith(from, to, nodes);
	view.dispatch(tr);
	return true;
}
