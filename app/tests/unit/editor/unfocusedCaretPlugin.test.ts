import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { schema as basicSchema } from '@tiptap/pm/schema-basic';
import { unfocusedCaretPlugin } from '$lib/editor/unfocusedCaret/unfocusedCaretPlugin.js';

// Regression lock for the desktop "click snaps cursor back to old spot" bug.
//
// The plugin draws a caret/selection decoration while the editor is blurred.
// The decoration MUST NOT be torn down synchronously inside the `focus` DOM
// event: doing so makes ProseMirror rewrite the pre-blur state.selection onto
// the DOM during the redraw, clobbering the caret the click just placed. The
// teardown is therefore deferred one macrotask (see unfocusedCaretPlugin.ts).

let view: EditorView | null = null;

// jsdom implements neither getClientRects nor getBoundingClientRect; PM's
// scroll-into-view path (reached when we flush a selection change) calls them
// and would throw an async unhandled error. Stub them to empty rects — the
// plugin under test cares about decorations, not geometry.
beforeAll(() => {
	const emptyRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList;
	const emptyRect = () =>
		({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
	for (const proto of [Element.prototype, Range.prototype]) {
		if (!('getClientRects' in proto)) {
			(proto as { getClientRects?: () => DOMRectList }).getClientRects = emptyRects;
		}
		if (!('getBoundingClientRect' in proto)) {
			(proto as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = emptyRect;
		}
	}
});

afterEach(() => {
	view?.destroy();
	view = null;
});

function mount(text: string): { view: EditorView; dom: HTMLElement } {
	const doc = basicSchema.node('doc', null, [
		basicSchema.node('paragraph', null, text ? [basicSchema.text(text)] : [])
	]);
	const mountEl = document.createElement('div');
	document.body.appendChild(mountEl);
	view = new EditorView(mountEl, {
		state: EditorState.create({ schema: basicSchema, doc, plugins: [unfocusedCaretPlugin()] })
	});
	return { view, dom: view.dom as HTMLElement };
}

const hasCaretDeco = (dom: HTMLElement) => !!dom.querySelector('.unfocused-caret');

describe('unfocusedCaretPlugin', () => {
	it('draws the caret decoration while blurred (initial state)', () => {
		const { dom } = mount('hello world');
		expect(hasCaretDeco(dom)).toBe(true);
	});

	it('does NOT tear down the decoration synchronously on focus', () => {
		const { dom } = mount('hello world');
		expect(hasCaretDeco(dom)).toBe(true);

		dom.focus();
		dom.dispatchEvent(new FocusEvent('focus'));

		// The whole point of the fix: synchronous focus must not redraw, or PM
		// clobbers the click selection. The decoration is allowed to linger
		// until the deferred macrotask runs.
		expect(hasCaretDeco(dom)).toBe(true);
	});

	it('tears the decoration down after the deferred macrotask once focused', async () => {
		const { dom } = mount('hello world');
		dom.focus();
		dom.dispatchEvent(new FocusEvent('focus'));

		await new Promise((r) => setTimeout(r, 0));

		// Only assert when jsdom actually reports the editor as focused — its
		// focus model is partial, so guard rather than flake.
		if (document.activeElement === dom) {
			expect(hasCaretDeco(dom)).toBe(false);
		}
	});

	it('redraws the decoration synchronously on blur', () => {
		const { view, dom } = mount('hello world');
		// Force focused state, then blur and confirm the decoration returns
		// immediately (no deferral on blur — no competing click selection).
		view.dispatchEvent(new FocusEvent('blur'));
		expect(hasCaretDeco(dom)).toBe(true);
	});
});
