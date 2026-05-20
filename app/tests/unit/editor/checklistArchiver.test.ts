import { describe, it, expect } from 'vitest';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

/** note-content 래퍼로 감싼다. */
const wrap = (inner: string) =>
	`<note-content version="0.1">${inner}</note-content>`;

describe('checklist marker serialization', () => {
	it('XML→JSON strips markers and sets checked', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[X] 우유\n</list-item>' +
				'<list-item dir="ltr">[ ] 빵</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content![2];
		expect(list.type).toBe('bulletList');
		const [li0, li1] = list.content!;
		expect(li0.attrs!.checked).toBe(true);
		expect(li1.attrs!.checked).toBe(false);
		expect(li0.content![0].content![0].text).toBe('우유');
		expect(li1.content![0].content![0].text).toBe('빵');
	});

	it('lowercase [x] is accepted as checked', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[x] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		expect(doc.content![2].content![0].attrs!.checked).toBe(true);
	});

	it('JSON→XML adds markers for checklist-region items', () => {
		const xml = serializeContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'text', text: '체크리스트:' }]
				},
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { checked: true },
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: '우유' }] }
							]
						},
						{
							type: 'listItem',
							attrs: { checked: false },
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: '빵' }] }
							]
						}
					]
				}
			]
		});
		expect(xml).toContain('[X] 우유');
		expect(xml).toContain('[ ] 빵');
	});

	it('XML→JSON→XML round-trips byte-identically for a checklist region', () => {
		const xml = wrap(
			'제목\n체크리스트: 장보기\n<list>' +
				'<list-item dir="ltr">[X] 우유\n</list-item>' +
				'<list-item dir="ltr">[ ] 빵</list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('round-trips nested checklist items', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[ ] 상위\n<list>' +
				'<list-item dir="ltr">[X] 하위</list-item>' +
				'</list></list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('leaves non-region lists untouched ([ ] stays literal text)', () => {
		const xml = wrap(
			'제목\n그냥 목록\n<list>' +
				'<list-item dir="ltr">[ ] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		// 영역이 아니므로 마커가 본문 텍스트로 남는다.
		expect(doc.content![2].content![0].content![0].content![0].text).toBe(
			'[ ] 우유'
		);
		expect(serializeContent(doc)).toBe(xml);
	});

	it('adds [ ] markers to a bare checklist region on serialize', () => {
		// 마커 없이 체크리스트 영역에 직접 타이핑한 기존 노트 — 저장 시 마커 획득.
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">우유</list-item>' +
				'</list>'
		);
		const out = serializeContent(deserializeContent(xml));
		expect(out).toContain('[ ] 우유');
	});

	it('round-trips a checklist item whose content text is marked', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[X] <bold>우유</bold></list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li0 = doc.content![2].content![0];
		expect(li0.attrs!.checked).toBe(true);
		// 마커는 제거되고, 굵게 표시된 본문 텍스트만 남는다.
		const firstText = li0.content![0].content![0];
		expect(firstText.text).toBe('우유');
		expect(firstText.marks?.[0].type).toBe('bold');
		expect(serializeContent(doc)).toBe(xml);
	});

	it('does not treat a checklist-format title as a region header', () => {
		// 제목 줄(블록 0)은 절대 헤더가 아니다 — 영역 미형성, 마커는 평문 유지.
		const xml = wrap(
			'체크리스트: 장보기\n<list>' +
				'<list-item dir="ltr">[ ] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li0 = doc.content![1].content![0];
		expect(li0.content![0].content![0].text).toBe('[ ] 우유');
		expect(serializeContent(doc)).toBe(xml);
	});
});
