import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';

function inlines(doc: ReturnType<typeof deserializeContent>, paraIdx: number) {
	return doc.content?.[paraIdx]?.content ?? [];
}

describe('archiver 읽기 — footnote 노드 split', () => {
	it('본문 중간 [^1] → text + 노드 + text', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n본문 [^1] 끝</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'text', text: '본문 ' },
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 끝' }
		]);
	});

	it('정의 단락 [^1] 본문 → 노드 + text', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^1] 정의 본문</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 정의 본문' }
		]);
	});

	it('마크가 마커를 가로지름 — bold 가 좌우로 split', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n<bold>x [^1] y</bold></note-content>`
		);
		const ins = inlines(doc, 1);
		expect(ins).toEqual([
			{ type: 'text', text: 'x ', marks: [{ type: 'bold' }] },
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' y', marks: [{ type: 'bold' }] }
		]);
	});

	it('한 단락 안에 여러 마커', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^1] 와 [^2]</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 와 ' },
			{ type: 'footnoteMarker', attrs: { label: '2' } }
		]);
	});

	it('비숫자 라벨 [^abc]', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^abc] 본문</note-content>`
		);
		expect(inlines(doc, 1)[0]).toMatchObject({
			type: 'footnoteMarker',
			attrs: { label: 'abc' }
		});
	});

	it('한글 라벨 [^참고1]', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^참고1] 본문</note-content>`
		);
		expect(inlines(doc, 1)[0]).toMatchObject({
			type: 'footnoteMarker',
			attrs: { label: '참고1' }
		});
	});

	it('malformed [^] / [^ x] 는 평문으로 남음', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^] 와 [^ x]</note-content>`
		);
		const ins = inlines(doc, 1);
		expect(ins).toEqual([{ type: 'text', text: '[^] 와 [^ x]' }]);
	});
});

describe('archiver 쓰기 — footnoteMarker 노드 → [^N] 텍스트', () => {
	function roundTrip(xml: string): string {
		return serializeContent(deserializeContent(xml));
	}

	it('본문 중간 마커 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n본문 [^1] 끝</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('정의 단락 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^1] 정의 본문</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('여러 마커 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^1] 와 [^2]</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('한글 라벨 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^참고1] 본문</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('마크 가로지름 — split 결과 (의도)', () => {
		const xml = `<note-content version="0.1">제목\n<bold>x [^1] y</bold></note-content>`;
		const out = roundTrip(xml);
		expect(out).toBe(
			`<note-content version="0.1">제목\n<bold>x </bold>[^1]<bold> y</bold></note-content>`
		);
		// idempotent: 한 번 더 돌려도 동일.
		expect(roundTrip(out)).toBe(out);
	});
});
