import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '../../../src/lib/core/noteContentArchiver';

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

describe('archiver: inlineCheckbox node → [ ]/[x] text', () => {
	it('serializes unchecked node to [ ]', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineCheckbox', attrs: { checked: false } },
						{ type: 'text', text: ' 우유' }
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('[ ] 우유');
	});

	it('serializes checked node to [x]', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: true } }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('[x]');
	});

	it('round-trips simple [ ]', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 우유</note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('[ ] 우유');
	});

	it('round-trips with mark crossing — bold splits around checkbox', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 [x] 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		// One bold span becomes two on serialize (intentional split):
		expect(back).toMatch(/<bold>중요 <\/bold>\[x\]<bold> 작업<\/bold>/);
	});
});

describe('archiver: [ ]/[x] inside <list-item>', () => {
	function firstListItemInlines(doc: any) {
		const list = doc.content.find((n: any) => n.type === 'bulletList');
		expect(list).toBeDefined();
		const item = list.content[0];
		expect(item.type).toBe('listItem');
		const para = item.content.find((n: any) => n.type === 'paragraph');
		expect(para).toBeDefined();
		return para.content;
	}

	it('parses [ ] in a list-item text node as inlineCheckbox', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">[ ] 우유 사기</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines[0]).toEqual({ type: 'inlineCheckbox', attrs: { checked: false } });
		expect(inlines[1]).toEqual({ type: 'text', text: ' 우유 사기' });
	});

	it('parses [x] in a list-item text node as checked inlineCheckbox', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">[x] 끝남</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines[0].type).toBe('inlineCheckbox');
		expect(inlines[0].attrs.checked).toBe(true);
	});

	it('parses [x] inside a marked inline element within a list-item', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr"><bold>중요 [x] 작업</bold></list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines).toHaveLength(3);
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('bold');
		expect(inlines[1].type).toBe('inlineCheckbox');
		expect(inlines[1].attrs.checked).toBe(true);
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('bold');
	});

	it('parses [x] inside a nested list-item', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">상위<list><list-item dir="ltr">[x] 하위</list-item></list></list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const list = doc.content!.find((n: any) => n.type === 'bulletList');
		const parent = list!.content![0];
		const nested = parent.content!.find((n: any) => n.type === 'bulletList');
		const nestedItem = nested!.content![0];
		const para = nestedItem.content!.find((n: any) => n.type === 'paragraph');
		expect(para!.content![0]).toEqual({ type: 'inlineCheckbox', attrs: { checked: true } });
	});

	it('round-trips [x] inside a list-item', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">[x] 끝남</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('<list-item dir="ltr">[x] 끝남</list-item>');
	});
});
