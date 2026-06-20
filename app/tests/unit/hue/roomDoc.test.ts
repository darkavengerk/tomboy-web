import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/node.js';
import { InlineRadio } from '$lib/editor/inlineRadio/node.js';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	findListByAtom,
	buildLightList,
	buildSceneList,
	lightContextAt,
	sceneContextAt
} from '$lib/hue/roomDoc.js';

let editor: Editor | null = null;
function make(): Editor {
	editor = new Editor({
		extensions: [StarterKit, InlineCheckbox, InlineRadio, TomboyInternalLink],
		content: '<p>조명::거실</p><p>room:x</p>'
	});
	return editor;
}
afterEach(() => {
	editor?.destroy();
	editor = null;
});

describe('buildLightList / findListByAtom / lightContextAt', () => {
	it('체크박스 리스트 빌드 + 탐색 + 컨텍스트', () => {
		const e = make();
		const list = buildLightList(e.schema, [
			{ title: '조명::메인등', checked: true },
			{ title: '조명::스탠드', checked: false }
		]);
		e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));
		expect(findListByAtom(e.state.doc, 'inlineCheckbox')).not.toBeNull();
		let cbPos = -1;
		e.state.doc.descendants((n, p) => {
			if (cbPos < 0 && n.type.name === 'inlineCheckbox') cbPos = p;
		});
		expect(lightContextAt(e.state.doc, cbPos)).toEqual({ title: '조명::메인등', checked: true });
	});
	it('빈 리스트도 유효한 bulletList', () => {
		const e = make();
		const list = buildLightList(e.schema, []);
		expect(list.type.name).toBe('bulletList');
		expect(list.childCount).toBe(1); // 빈 listItem 1개
	});
	it('atom 없는 위치 / 매칭 없음 → null', () => {
		const e = make();
		expect(findListByAtom(e.state.doc, 'inlineCheckbox')).toBeNull();
		expect(lightContextAt(e.state.doc, 1)).toBeNull(); // 제목 텍스트 위치, 체크박스 아님
	});
});

describe('buildSceneList / sceneContextAt', () => {
	it('라디오 리스트 + 컨텍스트(이름 + 형제 위치)', () => {
		const e = make();
		const list = buildSceneList(e.schema, [
			{ name: '영화', active: false },
			{ name: '독서', active: true }
		]);
		e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));
		const radios: number[] = [];
		e.state.doc.descendants((n, p) => {
			if (n.type.name === 'inlineRadio') radios.push(p);
		});
		expect(radios.length).toBe(2);
		const ctx = sceneContextAt(e.state.doc, radios[1]);
		expect(ctx?.name).toBe('독서');
		expect(ctx?.selected).toBe(true);
		expect(ctx?.siblings).toContain(radios[0]);
		expect(ctx?.siblings).not.toContain(radios[1]);
	});
});
