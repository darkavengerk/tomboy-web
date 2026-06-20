import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	findBoxList,
	buildLightList,
	buildSceneList,
	listItemAt,
	lightContextOf,
	sceneContextOf
} from '$lib/hue/roomDoc.js';

let editor: Editor | null = null;
function make(): Editor {
	editor = new Editor({
		// 실제 에디터와 동일: StarterKit 의 기본 listItem 을 끄고 boxKind/checked
		// attr 를 가진 TomboyListItem 으로 교체한다(listBox 항목 단위 박스).
		extensions: [StarterKit.configure({ listItem: false }), TomboyListItem, TomboyInternalLink],
		content: '<p>조명::거실</p><p>room:x</p>'
	});
	return editor;
}
afterEach(() => {
	editor?.destroy();
	editor = null;
});

/** doc 안에서 boxKind===kind 인 첫 listItem 의 {node,pos}. */
function firstBoxLi(e: Editor, kind: 'checkbox' | 'radio'): { node: PMNode; pos: number } | null {
	const out: { node: PMNode; pos: number }[] = [];
	e.state.doc.descendants((n, p) => {
		if (n.type.name === 'listItem' && n.attrs.boxKind === kind) out.push({ node: n, pos: p });
	});
	return out[0] ?? null;
}

describe('buildLightList / findBoxList / lightContextOf', () => {
	it('체크박스 listItem(boxKind) 빌드 + 탐색 + 컨텍스트', () => {
		const e = make();
		const list = buildLightList(e.schema, [
			{ title: '조명::메인등', checked: true },
			{ title: '조명::스탠드', checked: false }
		]);
		e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));

		// 인라인 atom 이 아니라 listItem attrs 로 상태를 들고 있어야 한다.
		expect(list.firstChild?.attrs.boxKind).toBe('checkbox');
		expect(list.firstChild?.attrs.checked).toBe(true);

		const box = findBoxList(e.state.doc, 'checkbox');
		expect(box).not.toBeNull();

		const li = firstBoxLi(e, 'checkbox');
		expect(li).not.toBeNull();
		expect(lightContextOf(li!.node)).toEqual({ title: '조명::메인등', checked: true });
	});

	it('빈 리스트도 유효한 bulletList', () => {
		const e = make();
		const list = buildLightList(e.schema, []);
		expect(list.type.name).toBe('bulletList');
		expect(list.childCount).toBe(1); // 빈 listItem 1개
	});

	it('boxKind 없으면 findBoxList null, 비-체크박스 li 는 컨텍스트 null', () => {
		const e = make();
		expect(findBoxList(e.state.doc, 'checkbox')).toBeNull();
		// 제목 문단 위치 → listItem 아님
		expect(listItemAt(e.state.doc, 1)).toBeNull();
	});
});

describe('buildSceneList / sceneContextOf', () => {
	it('라디오 listItem(boxKind) + 컨텍스트(이름 + 선택)', () => {
		const e = make();
		const list = buildSceneList(e.schema, [
			{ name: '영화', active: false },
			{ name: '독서', active: true }
		]);
		e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));

		expect(list.firstChild?.attrs.boxKind).toBe('radio');

		// 두 번째(독서)가 선택됨.
		const radioLis: PMNode[] = [];
		e.state.doc.descendants((n) => {
			if (n.type.name === 'listItem' && n.attrs.boxKind === 'radio') radioLis.push(n);
		});
		expect(radioLis.length).toBe(2);
		expect(sceneContextOf(radioLis[0])).toEqual({ name: '영화', selected: false });
		expect(sceneContextOf(radioLis[1])).toEqual({ name: '독서', selected: true });
	});
});

describe('listItemAt', () => {
	it('listItem 내부 위치 → 그 listItem {node,pos}', () => {
		const e = make();
		const list = buildLightList(e.schema, [{ title: '조명::메인등', checked: false }]);
		e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));
		const li = firstBoxLi(e, 'checkbox')!;
		// li 내부(콘텐츠 시작 근처) 위치를 resolve 하면 그 listItem 을 찾는다.
		const at = listItemAt(e.state.doc, li.pos + 2);
		expect(at?.pos).toBe(li.pos);
		expect(at?.node.attrs.boxKind).toBe('checkbox');
	});
});
