import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { TomboyInlineCheckbox } from '../../../src/lib/editor/inlineCheckbox';
import {
	createChartBlockPlugin,
	chartBlockPluginKey
} from '../../../src/lib/editor/chartBlock/chartBlockPlugin';

/**
 * Integration test at the plugin level: builds a real editor with the chart
 * plugin registered (alongside the inlineCheckbox node, which converts `[x]`
 * into an atom) and inspects the DecorationSet the plugin produces. This is the
 * test that would have caught the original break where findChartRegions read
 * plain-JSON text nodes and never saw the `[x]` marker in the live editor.
 *
 * Note: building decorations only constructs Decoration.widget(pos, renderFn)
 * — renderFn (which would load Chart.js / hit IndexedDB) is not invoked until
 * the DOM renders, so this stays a pure, headless check.
 */

const ChartBlockTestExtension = Extension.create({
	name: 'tomboyChartBlockTest',
	addProseMirrorPlugins() {
		return [createChartBlockPlugin()];
	}
});

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(content: JSONContent): Editor {
	const editor = new Editor({
		extensions: [StarterKit, ...TomboyInlineCheckbox, ChartBlockTestExtension],
		content
	});
	currentEditor = editor;
	return editor;
}

const CB = (checked: boolean): JSONContent => ({
	type: 'inlineCheckbox',
	attrs: { checked }
});
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

/** Collect all decorations from the plugin's DecorationSet covering the doc. */
function decorationsOf(editor: Editor) {
	const set = chartBlockPluginKey.getState(editor.state);
	if (!set) return [];
	return set.find(0, editor.state.doc.content.size);
}

describe('chartBlockPlugin decorations', () => {
	it('emits a chart widget for a CHECKED header (stored as inlineCheckbox atom)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				textPara('제목'),
				cbPara(true, ' Chart:bar 매출'),
				ul(li(textPara('DATA::데이터')))
			]
		});
		const decos = decorationsOf(editor);
		// One widget (the chart) + one node decoration (hide the config list).
		const widgets = decos.filter((d) => (d as any).type?.toDOM || (d as any).type?.widget);
		expect(decos.length).toBeGreaterThanOrEqual(1);
		// At least one decoration is a widget anchored after the header.
		const hasWidget = decos.some((d) => d.spec?.key?.toString().startsWith('chart:'));
		expect(hasWidget).toBe(true);
	});

	it('emits NO chart widget for an UNCHECKED header', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				textPara('제목'),
				cbPara(false, ' Chart:bar 매출'),
				ul(li(textPara('DATA::데이터')))
			]
		});
		const decos = decorationsOf(editor);
		const hasWidget = decos.some((d) => d.spec?.key?.toString().startsWith('chart:'));
		expect(hasWidget).toBe(false);
	});

	it('hides the config list when the chart is checked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				textPara('제목'),
				cbPara(true, ' Chart:bar 매출'),
				ul(li(textPara('DATA::데이터')))
			]
		});
		const decos = decorationsOf(editor);
		// A node decoration carrying the hide class covers the config list.
		const hideDeco = decos.find(
			(d) => (d as any).type?.attrs?.class === 'tomboy-chart-config-hidden'
		);
		expect(hideDeco).toBeDefined();
	});

	it('rebuilds decorations after the checkbox flips checked→unchecked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [textPara('제목'), cbPara(true, ' Chart:bar 매출')]
		});
		expect(decorationsOf(editor).some((d) => d.spec?.key?.toString().startsWith('chart:'))).toBe(
			true
		);
		// Find the inlineCheckbox position and flip it to unchecked.
		let cbPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === 'inlineCheckbox') cbPos = pos;
		});
		expect(cbPos).toBeGreaterThanOrEqual(0);
		editor.view.dispatch(editor.state.tr.setNodeAttribute(cbPos, 'checked', false));
		expect(decorationsOf(editor).some((d) => d.spec?.key?.toString().startsWith('chart:'))).toBe(
			false
		);
	});
});
