import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { itemSource, resultOf } from '$lib/musicExtract/parseExtractNote.js';

export type ResultPayload =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string };

function isList(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}
// 결과 링크는 텍스트와 href 를 동일한 URL 로 둔다. .note(<link:url>)가 텍스트만 보존하고
// href 를 textContent 에서 복원하므로(noteContentArchiver), 텍스트가 곧 URL이라야
// 저장→재로드(드롭박스/리로드/동기화) 후에도 결과 URL이 살아남는다. 표시 제목은 파서가
// 파일명에서 유도(deriveTitle). 다른 tomboyUrlLink 생산자(geo/image)와 동일 패턴.
export function urlChild(schema: Schema, url: string) {
	const markType = schema.marks.tomboyUrlLink ?? schema.marks.link;
	return markType ? schema.text(url, [markType.create({ href: url })]) : schema.text(url);
}

/** source 와 일치하고 아직 결과(=/files URL)가 없는 첫 top-level listItem 의 위치+노드. */
function findTarget(doc: PMNode, source: string): { liPos: number; node: PMNode } | null {
	let found: { liPos: number; node: PMNode } | null = null;
	doc.forEach((block, blockOffset) => {
		if (found || !isList(block)) return;
		block.forEach((li, liOffset) => {
			if (found || li.type.name !== 'listItem') return;
			if (itemSource(li) === source && resultOf(li).kind !== 'done') {
				found = { liPos: blockOffset + 1 + liOffset, node: li };
			}
		});
	});
	return found;
}

/** source 헤드를 가진 첫 미완료 항목 밑에 결과 자식을 기록(라이브 dispatch). */
export function writeExtractResult(view: EditorView, source: string, payload: ResultPayload): void {
	if (view.isDestroyed) return;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return;

	const target = findTarget(doc, source);
	if (!target) return;

	const childPara =
		payload.kind === 'done'
			? paragraph.create(null, urlChild(schema, payload.url))
			: paragraph.create(null, schema.text(`❌ 실패: ${payload.message}`));
	const childItem = listItem.create(null, childPara);

	const li = target.node;
	let nested: { pos: number; node: PMNode } | null = null;
	li.forEach((child, childOffset) => {
		if (!nested && isList(child)) nested = { pos: target.liPos + 1 + childOffset, node: child };
	});

	type NestedTarget = { pos: number; node: PMNode };
	const tr = state.tr;
	if (nested) {
		// 중첩 리스트 = 이 기능이 소유하는 단일-자식 결과 슬롯. 기존 결과(❌ 또는 링크)를
		// 통째로 교체한다(에러→성공 전환 포함). 항목당 결과는 항상 한 자식이라는 불변식.
		const n: NestedTarget = nested;
		tr.replaceWith(n.pos, n.pos + n.node.nodeSize, bulletList.create(n.node.attrs, childItem));
	} else {
		const headSize = li.firstChild?.nodeSize ?? 0;
		tr.insert(target.liPos + 1 + headSize, bulletList.create(null, childItem));
	}
	view.dispatch(tr);
}
