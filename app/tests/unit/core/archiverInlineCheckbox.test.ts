import { describe, it, expect } from 'vitest';
import { deserializeContent } from '../../../src/lib/core/noteContentArchiver';

function paragraphInlines(doc: any, idx = 1) {
	return doc.content[idx].content;
}

describe('archiver: [ ]/[x] text → inlineCheckbox node', () => {
	it('parses [ ] as unchecked inlineCheckbox', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 우유 사기</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineCheckbox',
			attrs: { checked: false }
		});
		expect(inlines[1]).toEqual({ type: 'text', text: ' 우유 사기' });
	});

	it('parses [x] as checked inlineCheckbox', () => {
		const xml = `<note-content version="0.1">제목\n[x] 끝난 일</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineCheckbox',
			attrs: { checked: true }
		});
	});

	it('parses uppercase [X] as checked', () => {
		const xml = `<note-content version="0.1">제목\n[X] 대문자</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0].attrs.checked).toBe(true);
	});

	it('handles mark-crossing — bold runs split around the checkbox', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 [ ] 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		// expect: bold "중요 " | inlineCheckbox | bold " 작업"
		expect(inlines).toHaveLength(3);
		expect(inlines[0].type).toBe('text');
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('bold');
		expect(inlines[1].type).toBe('inlineCheckbox');
		expect(inlines[1].attrs.checked).toBe(false);
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].type).toBe('text');
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('bold');
	});

	it('handles consecutive [ ][x] as two adjacent nodes', () => {
		const xml = `<note-content version="0.1">제목\n[ ][x]</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(2);
		expect(inlines[0].type).toBe('inlineCheckbox');
		expect(inlines[0].attrs.checked).toBe(false);
		expect(inlines[1].type).toBe('inlineCheckbox');
		expect(inlines[1].attrs.checked).toBe(true);
	});

	it('coexists with footnote markers in the same text', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 작업 [^1]</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		const types = inlines.map((n: any) => n.type);
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});
});
