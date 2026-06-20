/**
 * roomDoc.ts — 룸 노트 본문의 조명(체크박스)/씬(라디오) 리스트 빌더·탐색기.
 *
 * 순수 ProseMirror 함수만 포함. Svelte / 네트워크 / $state 없음.
 * GroupControl 위젯(Task 5)이 여기서 export한 함수를 호출해 doc을 조작한다.
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

/**
 * atomName(inlineCheckbox|inlineRadio) 을 포함한 첫 bulletList 의 {from,to}.
 * 없으면 null.
 */
export function findListByAtom(
	doc: PMNode,
	atomName: string
): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;
	doc.descendants((node, pos) => {
		if (result) return false;
		if (node.type.name !== 'bulletList') return; // 비-리스트는 계속 내려감
		let has = false;
		node.descendants((d) => {
			if (d.type.name === atomName) has = true;
		});
		if (has) result = { from: pos, to: pos + node.nodeSize };
		return false; // 매칭/비매칭 무관하게 이 리스트 내부는 안 들어감
	});
	return result;
}

/**
 * 조명 체크박스 bulletList 생성.
 * 각 listItem: paragraph → [ inlineCheckbox | text(title, tomboyInternalLink) ]
 */
export function buildLightList(schema: Schema, items: LightItem[]): PMNode {
	const cb = schema.nodes.inlineCheckbox;
	const li = schema.nodes.listItem;
	const bl = schema.nodes.bulletList;
	const p = schema.nodes.paragraph;
	const link = schema.marks.tomboyInternalLink;

	const lis = items.map((it) =>
		li.create(
			null,
			p.create(null, [
				cb.create({ checked: it.checked }),
				schema.text(it.title, [link.create({ target: it.title })])
			])
		)
	);
	return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

/**
 * 씬 라디오 bulletList 생성.
 * 각 listItem: paragraph → [ inlineRadio | text(' ' + name) ]
 */
export function buildSceneList(schema: Schema, items: SceneItem[]): PMNode {
	const radio = schema.nodes.inlineRadio;
	const li = schema.nodes.listItem;
	const bl = schema.nodes.bulletList;
	const p = schema.nodes.paragraph;

	const lis = items.map((it) =>
		li.create(null, p.create(null, [radio.create({ selected: it.active }), schema.text(' ' + it.name)]))
	);
	return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

/**
 * posAtDOM 오차 흡수: pos, pos-1, pos+1 중 atomName 노드를 찾는다.
 * 클릭 이벤트에서 얻은 PM 위치는 ±1 오차가 생길 수 있다.
 */
function atomAt(
	doc: PMNode,
	pos: number,
	name: string
): { node: PMNode; pos: number } | null {
	for (const p of [pos, pos - 1, pos + 1]) {
		if (p < 0 || p > doc.content.size) continue;
		const n = doc.nodeAt(p);
		if (n && n.type.name === name) return { node: n, pos: p };
	}
	return null;
}

/** pos 위치에서 가장 가까운 listItem 조상 노드. */
function listItemAncestor(doc: PMNode, pos: number): PMNode | null {
	const $pos = doc.resolve(pos);
	for (let d = $pos.depth; d > 0; d--) {
		if ($pos.node(d).type.name === 'listItem') return $pos.node(d);
	}
	return null;
}

/**
 * 체크박스 위치 → { title, checked }.
 * listItem 안의 tomboyInternalLink mark target을 title로 사용.
 * atomAt ±1 보정 포함.
 */
export function lightContextAt(
	doc: PMNode,
	pos: number
): { title: string; checked: boolean } | null {
	const found = atomAt(doc, pos, 'inlineCheckbox');
	if (!found) return null;
	const li = listItemAncestor(doc, found.pos);
	if (!li) return null;
	let title = '';
	li.descendants((n) => {
		if (title) return false; // 첫 링크 찾으면 조기 종료
		if (!n.isText) return;
		const m = n.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
		if (m) title = String(m.attrs.target ?? '');
	});
	return title ? { title, checked: !!found.node.attrs.checked } : null;
}

/**
 * 라디오 위치 → { name, selected, siblings }.
 * siblings: 같은 씬 리스트(bulletList) 내 다른 inlineRadio 위치 목록.
 * atomAt ±1 보정 포함.
 */
export function sceneContextAt(
	doc: PMNode,
	pos: number
): { name: string; selected: boolean; siblings: number[] } | null {
	const found = atomAt(doc, pos, 'inlineRadio');
	if (!found) return null;
	const list = findListByAtom(doc, 'inlineRadio');
	if (!list) return null;
	const siblings: number[] = [];
	doc.nodesBetween(list.from, list.to, (n, p) => {
		if (n.type.name === 'inlineRadio' && p !== found.pos) siblings.push(p);
	});
	const li = listItemAncestor(doc, found.pos);
	const name = (li?.textContent ?? '').trim();
	return { name, selected: !!found.node.attrs.selected, siblings };
}
