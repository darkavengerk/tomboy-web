import { describe, it, expect } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
	createChatNotePlugin,
	chatNotePluginKey
} from '$lib/editor/chatNote/chatNotePlugin.js';

function createTestEditor(claudeDefaults?: () => { system: string; model: string; effort: string }): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ undoRedo: false }),
			Extension.create({
				name: 'llmNoteExt',
				addProseMirrorPlugins() {
					return [createChatNotePlugin({ claudeDefaults })];
				}
			})
		],
		content: ''
	});
	return editor;
}

function editorParagraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(node.textContent);
	});
	return out;
}

describe('chatNotePlugin', () => {
	it('inserts title paragraph + headers + empty Q: after signature is typed', () => {
		const editor = createTestEditor();
		editor.commands.setContent('');
		editor.commands.insertContent('llm://qwen2.5-coder:3b');
		const paras = editorParagraphTexts(editor);
		expect(paras[0]).toBe('');
		expect(paras[1]).toBe('llm://qwen2.5-coder:3b');
		expect(paras).toContain('system: ');
		expect(paras).toContain('temperature: 0.3');
		expect(paras).toContain('num_ctx: 4096');
		expect(paras[paras.length - 1]).toBe('Q: ');
		const qIndex = paras.lastIndexOf('Q: ');
		expect(paras[qIndex - 1]).toBe('');
		editor.destroy();
	});

	it('does not re-apply auto-complete on subsequent transactions', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '셸 도우미' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'temperature: 0.5' }] },
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
			]
		});
		// User deletes the temperature line.
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '셸 도우미' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
			]
		});
		// Trigger a docChange tr that is NOT a fresh signature insertion.
		editor.commands.insertContentAt(editor.state.doc.content.size, 'x');
		const paras = editorParagraphTexts(editor);
		// temperature should NOT be re-added.
		expect(paras.filter((p) => p.startsWith('temperature:')).length).toBe(0);
		editor.destroy();
	});

	it('on rescan meta with header keys 0, fills the missing keys', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] }
			]
		});
		const tr = editor.state.tr.setMeta(chatNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: ');
		expect(paras).toContain('temperature: 0.3');
		expect(paras).toContain('num_ctx: 4096');
		expect(paras[paras.length - 1]).toBe('Q: ');
		editor.destroy();
	});

	it('on rescan with header keys present, does NOT modify the doc', () => {
		const editor = createTestEditor();
		const initialContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'temperature: 0.5' }] }
			]
		};
		editor.commands.setContent(initialContent);
		const before = editor.getJSON();
		const tr = editor.state.tr.setMeta(chatNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		const after = editor.getJSON();
		expect(after).toEqual(before);
		editor.destroy();
	});

	it('does nothing on docs without a signature', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'a regular note' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'with content' }] }
			]
		});
		// docChanged tr
		editor.commands.insertContentAt(editor.state.doc.content.size, 'x');
		// Trigger rescan too
		const tr = editor.state.tr.setMeta(chatNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		const allTexts = JSON.stringify(editor.getJSON());
		expect(allTexts).not.toContain('system: ');
		expect(allTexts).not.toContain('Q: ');
		editor.destroy();
	});

	it('rag-only header counts: rescan does not insert more headers', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://m' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'rag: 5' }] },
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
			]
		});
		const before = editor.getJSON();
		editor.view.dispatch(
			editor.state.tr.setMeta(chatNotePluginKey, { rescan: true })
		);
		expect(editor.getJSON()).toEqual(before);
		editor.destroy();
	});

	it('inserts claude headers (system/model/effort) with injected defaults', () => {
		const editor = createTestEditor(() => ({
			system: '번역기',
			model: 'opus',
			effort: 'xhigh'
		}));
		editor.commands.setContent('');
		editor.commands.insertContent('claude://');
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: 번역기');
		expect(paras).toContain('model: opus');
		expect(paras).toContain('effort: xhigh');
		expect(paras[paras.length - 1]).toBe('Q: ');
		const qIndex = paras.lastIndexOf('Q: ');
		expect(paras[qIndex - 1]).toBe('');
		editor.destroy();
	});

	it('falls back to hardcoded claude defaults when no closure given', () => {
		const editor = createTestEditor();
		editor.commands.setContent('');
		editor.commands.insertContent('claude://');
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: 당신은 사용자를 돕는 어시스턴트입니다.');
		expect(paras).toContain('model: opus');
		expect(paras).toContain('effort: high');
		editor.destroy();
	});
});
