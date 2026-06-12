import { describe, it, expect } from 'vitest';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

const wrap = (inner: string) =>
	`<note-content version="0.1">${inner}</note-content>`;

const LI = (
	text: string,
	attrs?: Record<string, unknown>
): Record<string, unknown> => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
});

describe('listBox per-item marker serialization', () => {
	it('영역 밖 checkbox/radio 항목에 마커를 붙인다', () => {
		const xml = serializeContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						LI('우유', { boxKind: 'checkbox', checked: true }),
						LI('빵', { boxKind: 'checkbox', checked: false }),
						LI('밥', { boxKind: 'radio', checked: true }),
						LI('면', { boxKind: 'radio', checked: false }),
						LI('그냥불릿')
					]
				}
			]
		});
		expect(xml).toContain('[[X]] 우유');
		expect(xml).toContain('[[ ]] 빵');
		expect(xml).toContain('((O)) 밥');
		expect(xml).toContain('(( )) 면');
		expect(xml).toContain('>그냥불릿');
	});

	it('XML→JSON: 영역 밖 마커를 떼고 boxKind/checked 설정', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">[[X]] 우유\n</list-item>' +
				'<list-item dir="ltr">(( )) 밥\n</list-item>' +
				'<list-item dir="ltr">((o)) 면</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content!.find((b) => b.type === 'bulletList')!;
		const [li0, li1, li2] = list.content!;
		expect(li0.attrs!.boxKind).toBe('checkbox');
		expect(li0.attrs!.checked).toBe(true);
		expect(li0.content![0].content![0].text).toBe('우유');
		expect(li1.attrs!.boxKind).toBe('radio');
		expect(li1.attrs!.checked).toBe(false);
		expect(li2.attrs!.boxKind).toBe('radio');
		expect(li2.attrs!.checked).toBe(true);
		expect(li2.content![0].content![0].text).toBe('면');
	});

	it('round-trip byte-identical', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">[[ ]] 우유\n</list-item>' +
				'<list-item dir="ltr">((O)) 밥</list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('중첩 리스트 항목 마커도 동작', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">부모\n<list>' +
				'<list-item dir="ltr">(( )) 자식\n</list-item>' +
				'</list>\n</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content!.find((b) => b.type === 'bulletList')!;
		const nested = list.content![0].content!.find(
			(c) => c.type === 'bulletList'
		)!;
		expect(nested.content![0].attrs!.boxKind).toBe('radio');
		expect(serializeContent(doc)).toBe(xml);
	});

	it('체크리스트: 영역 안은 기존 동작 — boxKind 미설정', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[[X]] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li = doc.content![2].content![0];
		expect(li.attrs!.checked).toBe(true);
		expect(li.attrs!.boxKind ?? null).toBeNull();
		expect(serializeContent(doc)).toBe(xml);
	});

	it('텍스트 중간 (( )) 는 마커가 아니다', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">점심 (( )) 미정</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li = doc.content!.find((b) => b.type === 'bulletList')!.content![0];
		expect(li.attrs?.boxKind ?? null).toBeNull();
		expect(li.content![0].content![0].text).toBe('점심 (( )) 미정');
		expect(serializeContent(doc)).toBe(xml);
	});
});
