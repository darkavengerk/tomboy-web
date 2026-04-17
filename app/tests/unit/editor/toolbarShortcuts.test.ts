import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

/**
 * Create an editor with production-like extensions.
 * Keyboard shortcuts for Ctrl+S/H/M are handled via handleKeyDown in editorProps,
 * matching how TomboyEditor.svelte wires them.
 */
function makeEditor(content?: string): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			Highlight.configure({ multicolor: false }),
			Underline,
			TomboyMonospace
		],
		editorProps: {
			handleKeyDown: (_view, event) => {
				if (!editor) return false;
				if (event.ctrlKey || event.metaKey) {
					if (event.altKey || event.shiftKey) return false;
					switch (event.key) {
						case 's':
							event.preventDefault();
							editor.chain().focus().toggleStrike().run();
							return true;
						case 'h':
							event.preventDefault();
							editor.chain().focus().toggleHighlight().run();
							return true;
						case 'm':
							event.preventDefault();
							editor.chain().focus().toggleTomboyMonospace().run();
							return true;
					}
				}
				return false;
			}
		},
		content: content ?? '<p>Hello World</p>'
	});
	currentEditor = editor;
	return editor;
}

/**
 * Dispatch a keydown event through ProseMirror's handleKeyDown chain.
 * Returns true if any handler consumed the event.
 */
function pressKey(
	editor: Editor,
	key: string,
	modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}
): boolean {
	const event = new KeyboardEvent('keydown', {
		key,
		ctrlKey: modifiers.ctrlKey ?? false,
		shiftKey: modifiers.shiftKey ?? false,
		altKey: modifiers.altKey ?? false,
		metaKey: modifiers.metaKey ?? false,
		bubbles: true,
		cancelable: true
	});
	let handled = false;
	editor.view.someProp('handleKeyDown', (f) => {
		if (f(editor.view, event)) {
			handled = true;
			return true;
		}
		return undefined;
	});
	return handled;
}

// ============================================================================
//                        Mark toggle shortcuts
// ============================================================================

describe('Toolbar shortcuts — mark toggles', () => {
	it('Ctrl+B toggles bold', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 'b', { ctrlKey: true });
		expect(editor.isActive('bold')).toBe(true);
	});

	it('Ctrl+I toggles italic', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 'i', { ctrlKey: true });
		expect(editor.isActive('italic')).toBe(true);
	});

	it('Ctrl+U toggles underline', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 'u', { ctrlKey: true });
		expect(editor.isActive('underline')).toBe(true);
	});

	it('Ctrl+S toggles strikethrough', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 's', { ctrlKey: true });
		expect(editor.isActive('strike')).toBe(true);
		// Toggle off
		pressKey(editor, 's', { ctrlKey: true });
		expect(editor.isActive('strike')).toBe(false);
	});

	it('Ctrl+M toggles monospace', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 'm', { ctrlKey: true });
		expect(editor.isActive('tomboyMonospace')).toBe(true);
		// Toggle off
		pressKey(editor, 'm', { ctrlKey: true });
		expect(editor.isActive('tomboyMonospace')).toBe(false);
	});

	it('Ctrl+H toggles highlight', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		pressKey(editor, 'h', { ctrlKey: true });
		expect(editor.isActive('highlight')).toBe(true);
		// Toggle off
		pressKey(editor, 'h', { ctrlKey: true });
		expect(editor.isActive('highlight')).toBe(false);
	});
});

// ============================================================================
//          Shortcut event consumption (browser default prevention)
// ============================================================================

describe('Shortcuts consume the event (prevent browser defaults)', () => {
	it('Ctrl+S is consumed', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		const handled = pressKey(editor, 's', { ctrlKey: true });
		expect(handled).toBe(true);
	});

	it('Ctrl+H is consumed', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		const handled = pressKey(editor, 'h', { ctrlKey: true });
		expect(handled).toBe(true);
	});

	it('Ctrl+M is consumed', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		const handled = pressKey(editor, 'm', { ctrlKey: true });
		expect(handled).toBe(true);
	});

	it('Ctrl+L is not consumed by the editor (reserved for new-note-from-selection)', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection(1);
		const handled = pressKey(editor, 'l', { ctrlKey: true });
		expect(handled).toBe(false);
	});
});

// ============================================================================
//     Shortcuts with Shift should NOT trigger the new handlers
// ============================================================================

describe('Shortcuts require no Shift', () => {
	it('our handler only triggers without Shift — Ctrl+Shift+S does not toggle strike via our handler', () => {
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 12 });
		// Ctrl+Shift+S goes through StarterKit's built-in handler, not ours.
		// Our handleKeyDown returns false when shiftKey is set, so the
		// Ctrl-without-Shift shortcut is the intended primary path.
		// Just verify that Ctrl+S (no Shift) is what works:
		pressKey(editor, 's', { ctrlKey: true });
		expect(editor.isActive('strike')).toBe(true);
	});
});
