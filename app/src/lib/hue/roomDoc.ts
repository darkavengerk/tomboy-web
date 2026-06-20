/**
 * roomDoc.ts — 룸/존 노트 본문의 조명(체크박스)/씬(라디오) 리스트 빌더·탐색기.
 *
 * 순수 ProseMirror 함수만 포함. Svelte / 네트워크 / $state 없음.
 * GroupControl 위젯이 여기서 export한 함수를 호출해 doc을 조작한다.
 *
 * 박스는 **항목 단위 listBox**(listItem attrs boxKind/checked, [[ ]]/(( ))
 * 마커) 로 만든다 — 인라인 atom([ ]/( )) 이 아니다. 토글은 전역
 * TomboyListBox 플러그인이 클릭에서 attr 을 뒤집고(onToggleCheck/Radio →
 * toggleCheckboxAt/toggleRadioAt), GroupControl 은 캡처 단계에서 토글 *전*
 * 의 li 상태를 읽고 반전해(클릭은 항상 반전되므로) Hue 로 전송한다.
 * 마이크로태스크는 리스너 사이에서 돌아 토글 전 값을 읽으므로 쓰지 않는다.
 */
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

export interface LightItem {
	title: string;
	checked: boolean;
}

export interface SceneItem {
	name: string;
	active: boolean;
}

type BoxKind = 'checkbox' | 'radio';

/**
 * boxKind===kind 인 listItem 을 직계로 가진 첫 bulletList 의 {from,to}.
 * 없으면 null.
 */
export function findBoxList(
	doc: PMNode,
	kind: BoxKind
): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;
	doc.descendants((node, pos) => {
		if (result) return false;
		if (node.type.name !== 'bulletList') return; // 비-리스트는 계속 내려감
		let has = false;
		node.forEach((li) => {
			if (li.type.name === 'listItem' && li.attrs.boxKind === kind) has = true;
		});
		if (has) result = { from: pos, to: pos + node.nodeSize };
		return false; // 매칭/비매칭 무관하게 이 리스트 내부는 안 들어감
	});
	return result;
}

/**
 * 조명 체크박스 bulletList 생성.
 * 각 listItem: boxKind='checkbox' + paragraph(text(title, tomboyInternalLink)).
 */
export function buildLightList(schema: Schema, items: LightItem[]): PMNode {
	const li = schema.nodes.listItem;
	const bl = schema.nodes.bulletList;
	const p = schema.nodes.paragraph;
	const link = schema.marks.tomboyInternalLink;

	const lis = items.map((it) =>
		li.create(
			{ boxKind: 'checkbox', checked: it.checked },
			p.create(null, schema.text(it.title, [link.create({ target: it.title })]))
		)
	);
	return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

/**
 * 씬 라디오 bulletList 생성.
 * 각 listItem: boxKind='radio' + paragraph(text(name)).
 */
export function buildSceneList(schema: Schema, items: SceneItem[]): PMNode {
	const li = schema.nodes.listItem;
	const bl = schema.nodes.bulletList;
	const p = schema.nodes.paragraph;

	const lis = items.map((it) =>
		li.create({ boxKind: 'radio', checked: it.active }, p.create(null, schema.text(it.name)))
	);
	return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

/**
 * pos 위치에서 가장 가까운 listItem 의 {node, pos}. 없으면 null.
 * pos 는 doc 범위로 클램프해 클릭에서 얻은 위치의 경미한 오차를 흡수한다.
 */
export function listItemAt(
	doc: PMNode,
	pos: number
): { node: PMNode; pos: number } | null {
	const clamped = Math.max(0, Math.min(pos, doc.content.size));
	const $pos = doc.resolve(clamped);
	for (let d = $pos.depth; d > 0; d--) {
		if ($pos.node(d).type.name === 'listItem') {
			return { node: $pos.node(d), pos: $pos.before(d) };
		}
	}
	return null;
}

/**
 * 체크박스 listItem → { title, checked }.
 * listItem 안의 tomboyInternalLink mark target을 title로 사용.
 * boxKind!=='checkbox' 이거나 링크가 없으면 null.
 */
export function lightContextOf(li: PMNode): { title: string; checked: boolean } | null {
	if (li.type.name !== 'listItem' || li.attrs.boxKind !== 'checkbox') return null;
	let title = '';
	li.descendants((n) => {
		if (title) return false; // 첫 링크 찾으면 조기 종료
		if (!n.isText) return;
		const m = n.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
		if (m) title = String(m.attrs.target ?? '');
	});
	return title ? { title, checked: !!li.attrs.checked } : null;
}

/**
 * 라디오 listItem → { name, selected }.
 * listItem 텍스트 = 씬 이름. boxKind!=='radio' 이거나 이름이 비면 null.
 */
export function sceneContextOf(li: PMNode): { name: string; selected: boolean } | null {
	if (li.type.name !== 'listItem' || li.attrs.boxKind !== 'radio') return null;
	const name = li.textContent.trim();
	return name ? { name, selected: !!li.attrs.checked } : null;
}
