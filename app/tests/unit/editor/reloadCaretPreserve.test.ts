import { describe, it, expect } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { schema as basicSchema } from '@tiptap/pm/schema-basic';
import { restoreSelectionClamped } from '$lib/editor/restoreSelection.js';

function docState(text: string): EditorState {
	const doc = basicSchema.node('doc', null, [
		basicSchema.node('paragraph', null, text ? [basicSchema.text(text)] : [])
	]);
	return EditorState.create({ schema: basicSchema, doc });
}

describe('restoreSelectionClamped', () => {
	it('restores an in-range caret position', () => {
		const st = docState('hello world');
		const tr = restoreSelectionClamped(st, { from: 4, to: 4 });
		expect(tr).not.toBeNull();
		expect(tr!.selection.from).toBe(4);
	});

	it('clamps a past-end position to the new doc size', () => {
		const st = docState('hi'); // doc smaller than saved offset
		const tr = restoreSelectionClamped(st, { from: 999, to: 999 });
		expect(tr).not.toBeNull();
		expect(tr!.selection.from).toBeLessThanOrEqual(st.doc.content.size);
	});

	it('never throws on an empty doc', () => {
		const st = docState('');
		expect(() => restoreSelectionClamped(st, { from: 0, to: 0 })).not.toThrow();
	});
});
