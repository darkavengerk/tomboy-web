import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboySubtitlePlaceholder } from '$lib/editor/extensions/TomboySubtitlePlaceholder.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(opts: { content: unknown; text: string | null }): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false }),
			TomboySubtitlePlaceholder.configure({
				getPlaceholderText: () => opts.text
			})
		],
		content: opts.content as never
	});
	currentEditor = editor;
	return editor;
}

function hasPlaceholderClass(editor: Editor): boolean {
	return !!editor.view.dom.querySelector('p.tomboy-subtitle-placeholder');
}

function placeholderAttr(editor: Editor): string | null {
	const el = editor.view.dom.querySelector('p.tomboy-subtitle-placeholder');
	return el?.getAttribute('data-placeholder') ?? null;
}

describe('TomboySubtitlePlaceholder', () => {
	const docWithEmptySecondLine = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '2026-04-17' }] },
			{ type: 'paragraph' },
			{ type: 'paragraph' }
		]
	};

	it('decorates the empty second paragraph with the placeholder text', () => {
		const editor = makeEditor({
			content: docWithEmptySecondLine,
			text: '2026-04-17'
		});
		// Cursor is at top by default — but TipTap focuses the end on init.
		// Explicitly move selection to the very start (first paragraph).
		editor.commands.setTextSelection(1);
		expect(hasPlaceholderClass(editor)).toBe(true);
		expect(placeholderAttr(editor)).toBe('2026-04-17');
	});

	it('hides the placeholder when the cursor is on the second paragraph', () => {
		const editor = makeEditor({
			content: docWithEmptySecondLine,
			text: '2026-04-17'
		});
		// Position inside the second paragraph (after first para's close token).
		// doc: [para "2026-04-17"(size 12), para empty(size 2), para empty(size 2)]
		// second paragraph starts at 12; inside = 13.
		editor.commands.setTextSelection(13);
		expect(hasPlaceholderClass(editor)).toBe(false);
	});

	it('hides when the second paragraph has content', () => {
		const editor = makeEditor({
			content: {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'subtitle text' }]
					}
				]
			},
			text: '2026-04-17'
		});
		editor.commands.setTextSelection(1);
		expect(hasPlaceholderClass(editor)).toBe(false);
	});

	it('hides when the placeholder text is null', () => {
		const editor = makeEditor({
			content: docWithEmptySecondLine,
			text: null
		});
		editor.commands.setTextSelection(1);
		expect(hasPlaceholderClass(editor)).toBe(false);
	});

	it('hides when the document has fewer than 2 top-level blocks', () => {
		const editor = makeEditor({
			content: {
				type: 'doc',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: 'solo' }] }]
			},
			text: '2026-04-17'
		});
		editor.commands.setTextSelection(1);
		expect(hasPlaceholderClass(editor)).toBe(false);
	});

	it('reappears after the user deletes the subtitle text', () => {
		const editor = makeEditor({
			content: {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
					{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }
				]
			},
			text: '2026-04-17'
		});
		editor.commands.setTextSelection(1);
		expect(hasPlaceholderClass(editor)).toBe(false);

		// Delete the 'x' — second paragraph becomes empty, cursor stays on first line.
		const $start = editor.state.doc.resolve(editor.state.doc.child(0).nodeSize + 1);
		editor.commands.setTextSelection({
			from: $start.pos,
			to: $start.pos + 1
		});
		editor.commands.deleteSelection();
		editor.commands.setTextSelection(1);

		expect(hasPlaceholderClass(editor)).toBe(true);
	});
});
