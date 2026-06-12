import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

/** note-content 래퍼로 감싼다. */
const wrap = (inner: string) =>
	`<note-content version="0.1">${inner}</note-content>`;

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [P(text)]
});
const LI_NESTED = (
	text: string,
	nested: JSONContent,
	attrs?: Record<string, unknown>
): JSONContent => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [P(text), nested]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

/**
 * 프로세스 블록 한 개짜리 문서:
 *   제목 / Process: 작업 / [카드 > 하부 > (세부1✓, 세부2)] / Complete:
 */
function processDoc(): JSONContent {
	return {
		type: 'doc',
		content: [
			P('제목'),
			P('Process: 작업'),
			UL(
				LI_NESTED(
					'카드',
					UL(
						LI_NESTED(
							'하부',
							UL(LI('세부1', { checked: true }), LI('세부2', { checked: false }))
						)
					)
				)
			),
			P('Complete:')
		]
	};
}

describe('process block depth-3 checkbox marker serialization', () => {
	it('JSON→XML: depth-3 items get [[X]] / [[ ]] markers, depth-1/2 do not', () => {
		const xml = serializeContent(processDoc());
		expect(xml).toContain('[[X]] 세부1');
		expect(xml).toContain('[[ ]] 세부2');
		expect(xml).not.toContain('[[ ]] 카드');
		expect(xml).not.toContain('[[X]] 카드');
		expect(xml).not.toContain('[[ ]] 하부');
	});

	it('XML→JSON: strips depth-3 markers and sets checked, leaves depth-1/2 alone', () => {
		const xml = serializeContent(processDoc());
		const doc = deserializeContent(xml);

		const list = doc.content![2];
		expect(list.type).toBe('bulletList');
		const card = list.content![0]; // depth-1 카드
		expect(card.content![0].content![0].text).toBe('카드');
		const sub = card.content![1].content![0]; // depth-2 하부
		expect(sub.content![0].content![0].text).toBe('하부');
		const steps = sub.content![1].content!; // depth-3 세부1/세부2
		expect(steps[0].attrs!.checked).toBe(true);
		expect(steps[1].attrs!.checked).toBe(false);
		expect(steps[0].content![0].content![0].text).toBe('세부1');
		expect(steps[1].content![0].content![0].text).toBe('세부2');
	});

	it('XML→JSON→XML round-trips byte-identically', () => {
		const xml = serializeContent(processDoc());
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('no markers without a Complete: terminal (not a process block)', () => {
		const doc = processDoc();
		// Complete: 문단 제거 → 프로세스 블록 아님.
		doc.content = doc.content!.slice(0, 3);
		const xml = serializeContent(doc);
		expect(xml).not.toContain('[[X]]');
		expect(xml).not.toContain('[[ ]]');
	});

	it('blank / --- paragraphs inside the block do not break marker emission', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				P('제목'),
				P('Process: 작업'),
				P(''),
				UL(
					LI_NESTED(
						'카드',
						UL(LI_NESTED('하부', UL(LI('세부', { checked: true }))))
					)
				),
				P('---'),
				P('공정1'),
				P('Complete:')
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('[[X]] 세부');
	});

	it('depth-3 [[ ]] text outside a process block is per-item checkbox on parse', () => {
		// Task 3 이후: 영역 밖 [[ ]] 는 어떤 깊이에서도 per-item checkbox 마커.
		const xml = wrap(
			'제목\n그냥 목록\n<list>' +
				'<list-item dir="ltr">카드\n<list>' +
				'<list-item dir="ltr">하부\n<list>' +
				'<list-item dir="ltr">[[ ]] 세부\n</list-item>' +
				'</list>\n</list-item>' +
				'</list>\n</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const card = doc.content![2].content![0];
		const sub = card.content![1].content![0];
		const step = sub.content![1].content![0];
		// 프로세스 블록이 아니므로 체크리스트 영역 처리는 없지만,
		// listBox 전역 패스가 [[ ]] 를 per-item checkbox 마커로 처리한다.
		expect(step.attrs!.boxKind).toBe('checkbox');
		expect(step.attrs!.checked).toBe(false);
		expect(step.content![0].content![0].text).toBe('세부');
		expect(serializeContent(doc)).toBe(xml);
	});

	it('checklist region header as a stage header: checklist takes precedence (all depths marked)', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				P('제목'),
				P('Process: 작업'),
				P('체크리스트: 단계'),
				UL(LI('항목', { checked: true })),
				P('Complete:')
			]
		};
		const xml = serializeContent(doc);
		// 체크리스트 영역 규칙이 우선 — depth-1 에도 마커.
		expect(xml).toContain('[[X]] 항목');
		// 파싱도 동일하게 우선순위 적용 → round-trip 유지.
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});
});
