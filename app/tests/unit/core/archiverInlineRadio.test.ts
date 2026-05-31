import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '../../../src/lib/core/noteContentArchiver';

function paragraphInlines(doc: any, idx = 1) {
	return doc.content[idx].content;
}

describe('archiver: ( )/(o) text → inlineRadio node', () => {
	it('parses ( ) as unselected inlineRadio', () => {
		const xml = `<note-content version="0.1">제목\n( ) 사과</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineRadio',
			attrs: { selected: false }
		});
		expect(inlines[1]).toEqual({ type: 'text', text: ' 사과' });
	});

	it('parses (o) as selected inlineRadio', () => {
		const xml = `<note-content version="0.1">제목\n(o) 선택됨</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineRadio',
			attrs: { selected: true }
		});
	});

	it('parses uppercase (O) as selected', () => {
		const xml = `<note-content version="0.1">제목\n(O) 대문자</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0].attrs.selected).toBe(true);
	});

	it('handles mark-crossing — bold splits around the radio', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 ( ) 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(3);
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('bold');
		expect(inlines[1].type).toBe('inlineRadio');
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('bold');
	});

	it('coexists with checkbox and footnote in same text', () => {
		const xml = `<note-content version="0.1">제목\n( ) A [ ] B [^1] (o) C</note-content>`;
		const doc = deserializeContent(xml);
		const types = paragraphInlines(doc).map((n: any) => n.type);
		expect(types).toContain('inlineRadio');
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});

	it('handles consecutive ( )(o) as two adjacent nodes', () => {
		const xml = `<note-content version="0.1">제목\n( )(o)</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(2);
		expect(inlines[0].type).toBe('inlineRadio');
		expect(inlines[0].attrs.selected).toBe(false);
		expect(inlines[1].type).toBe('inlineRadio');
		expect(inlines[1].attrs.selected).toBe(true);
	});
});

describe('archiver: inlineRadio node → ( )/(o) text', () => {
	it('serializes unselected node to ( )', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: false } },
						{ type: 'text', text: ' 사과' }
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('( ) 사과');
	});

	it('serializes selected node to (o)', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineRadio', attrs: { selected: true } }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('(o)');
	});

	it('round-trips simple ( ) 사과', () => {
		const xml = `<note-content version="0.1">제목\n( ) 사과</note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('( ) 사과');
	});

	it('round-trips with mark crossing — bold splits around radio', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 (o) 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toMatch(/<bold>중요 <\/bold>\(o\)<bold> 작업<\/bold>/);
	});
});

describe('archiver: ( )/(o) inside <list-item>', () => {
	function firstListItemInlines(doc: any) {
		const list = doc.content.find((n: any) => n.type === 'bulletList');
		expect(list).toBeDefined();
		const item = list.content[0];
		expect(item.type).toBe('listItem');
		const para = item.content.find((n: any) => n.type === 'paragraph');
		expect(para).toBeDefined();
		return para.content;
	}

	it('parses ( ) in a list-item text node as inlineRadio', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">( ) 사과</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines[0]).toEqual({ type: 'inlineRadio', attrs: { selected: false } });
		expect(inlines[1]).toEqual({ type: 'text', text: ' 사과' });
	});

	it('parses (o) in a list-item text node as selected inlineRadio', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">(o) 선택됨</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines[0].type).toBe('inlineRadio');
		expect(inlines[0].attrs.selected).toBe(true);
	});

	it('parses (o) inside a marked inline element within a list-item', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr"><italic>중요 (o) 작업</italic></list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = firstListItemInlines(doc);
		expect(inlines).toHaveLength(3);
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('italic');
		expect(inlines[1].type).toBe('inlineRadio');
		expect(inlines[1].attrs.selected).toBe(true);
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('italic');
	});

	it('round-trips (o) inside a list-item', () => {
		const xml =
			`<note-content version="0.1">제목\n<list><list-item dir="ltr">(o) 선택됨</list-item></list></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('<list-item dir="ltr">(o) 선택됨</list-item>');
	});
});
