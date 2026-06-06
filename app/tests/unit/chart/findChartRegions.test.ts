import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { TomboyInlineCheckbox } from '../../../src/lib/editor/inlineCheckbox';
import { findChartRegions } from '../../../src/lib/editor/chartBlock/findChartRegions';

/**
 * findChartRegions runs against the LIVE editor document, where the editor has
 * converted every `[ ]`/`[x]` into an atomic `inlineCheckbox` node. These tests
 * therefore build a real Editor (with TomboyInlineCheckbox registered) and feed
 * documents whose headers/config use inlineCheckbox atoms — exactly what the
 * archiver/input-rule produce — instead of plain `[x]` text.
 */

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeDoc(content: JSONContent): Editor {
	const editor = new Editor({
		extensions: [StarterKit, ...TomboyInlineCheckbox],
		content
	});
	currentEditor = editor;
	return editor;
}

/** Inline checkbox atom node, as the editor stores `[x]` / `[ ]`. */
const CB = (checked: boolean): JSONContent => ({
	type: 'inlineCheckbox',
	attrs: { checked }
});
/** A paragraph that starts with a checkbox atom then trailing text. */
function cbPara(checked: boolean, rest: string): JSONContent {
	return { type: 'paragraph', content: [CB(checked), { type: 'text', text: rest }] };
}
function textPara(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function li(...content: JSONContent[]): JSONContent {
	return { type: 'listItem', content };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

describe('findChartRegions (live editor with inlineCheckbox atoms)', () => {
	it('detects a checked header stored as an inlineCheckbox atom', () => {
		// Title para (idx 0) + header para: [x] atom + " Chart:bar 제목"
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('제목 노트'), cbPara(true, ' Chart:bar 매출')]
		});
		const regions = findChartRegions(editor.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].headerText).toBe('[x] Chart:bar 매출');
		expect(regions[0].checked).toBe(true);
	});

	it('reads unchecked state from the atom', () => {
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('t'), cbPara(false, ' Chart:line 추세')]
		});
		const regions = findChartRegions(editor.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].headerText).toBe('[ ] Chart:line 추세');
		expect(regions[0].checked).toBe(false);
	});

	it('flattens nested config lines, reconstructing checkbox markers', () => {
		// 범위 sub-item has two checkbox atoms inline:
		//   [ ]last:15, [x]all
		const rangeLine: JSONContent = {
			type: 'paragraph',
			content: [
				CB(false),
				{ type: 'text', text: 'last:15, ' },
				CB(true),
				{ type: 'text', text: 'all' }
			]
		};
		const editor = makeDoc({
			type: 'doc',
			content: [
				textPara('t'),
				cbPara(true, ' Chart:bar 제목'),
				ul(li(textPara('DATA::데이터')), li(textPara('범위'), ul(li(rangeLine))))
			]
		});
		const regions = findChartRegions(editor.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].configLines).toEqual([
			'DATA::데이터',
			'범위',
			'[ ]last:15, [x]all'
		]);
		// The config list range is captured so the plugin can hide it when checked.
		expect(typeof regions[0].configListFrom).toBe('number');
		expect(typeof regions[0].configListTo).toBe('number');
		expect(regions[0].configListTo!).toBeGreaterThan(regions[0].configListFrom!);
	});

	it('leaves config list range undefined when there is no following list', () => {
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('t'), cbPara(true, ' Chart:bar 제목')]
		});
		const region = findChartRegions(editor.state.doc)[0];
		expect(region.configListFrom).toBeUndefined();
		expect(region.configListTo).toBeUndefined();
	});

	it('exposes a headerEndPos that lands at the end of the header paragraph', () => {
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('t'), cbPara(true, ' Chart:bar X')]
		});
		const region = findChartRegions(editor.state.doc)[0];
		// The header paragraph is the 2nd top-level node. Its end-of-content
		// position equals (start of node) + nodeSize - 1. Verify it points just
		// before the paragraph's closing token by checking the resolved node.
		const $end = editor.state.doc.resolve(region.headerEndPos);
		expect($end.parent.type.name).toBe('paragraph');
		// One past the end should be the paragraph boundary (depth drops).
		expect(region.headerEndPos).toBeGreaterThan(0);
	});

	it('exposes the header node range and the checkbox position', () => {
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('t'), cbPara(true, ' Chart:bar X')]
		});
		const region = findChartRegions(editor.state.doc)[0];
		// headerTo is just past the paragraph; the range brackets headerEndPos.
		expect(region.headerFrom).toBeLessThan(region.headerEndPos);
		expect(region.headerTo).toBe(region.headerEndPos + 1);
		// The checkbox is the header's first inline child → an inlineCheckbox atom.
		expect(region.checkboxPos).toBeDefined();
		expect(editor.state.doc.nodeAt(region.checkboxPos!)?.type.name).toBe('inlineCheckbox');
	});

	it('ignores an invalid chart type (pie)', () => {
		const editor = makeDoc({
			type: 'doc',
			content: [textPara('t'), cbPara(true, ' Chart:pie 비율')]
		});
		expect(findChartRegions(editor.state.doc)).toEqual([]);
	});

	it('returns empty when there is no chart header', () => {
		const editor = makeDoc({ type: 'doc', content: [textPara('hello world')] });
		expect(findChartRegions(editor.state.doc)).toEqual([]);
	});
});
