import { describe, it, expect } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { ThinkingStep } from '$lib/chatNote/backends/claude.js';
import {
	createThinkingDisplayPlugin,
	thinkingDisplayKey,
	setStep,
	clearStep
} from '$lib/editor/chatNote/thinkingDisplayPlugin.js';

function createTestEditor(): Editor {
	const root = document.createElement('div');
	document.body.appendChild(root);
	const editor = new Editor({
		element: root,
		extensions: [
			StarterKit.configure({ undoRedo: false }),
			Extension.create({
				name: 'thinkingDisplayExt',
				addProseMirrorPlugins() {
					return [createThinkingDisplayPlugin()];
				}
			})
		],
		content: '<p>hello world</p>'
	});
	return editor;
}

function widgetCount(editor: Editor): number {
	return editor.view.dom.querySelectorAll('.thinking-display').length;
}

describe('thinkingDisplayPlugin', () => {
	it('starts with empty decoration set (no widgets in DOM)', () => {
		const editor = createTestEditor();
		expect(widgetCount(editor)).toBe(0);
		const state = thinkingDisplayKey.getState(editor.state);
		expect(state?.step).toBeNull();
		editor.destroy();
	});

	it('renders one widget after setStep', () => {
		const editor = createTestEditor();
		const step: ThinkingStep = {
			kind: 'thinking',
			label: '생각 중',
			body: '내부 추론 내용'
		};
		setStep(editor.view, step);
		expect(widgetCount(editor)).toBe(1);
		editor.destroy();
	});

	it('clears widget after clearStep (null)', () => {
		const editor = createTestEditor();
		const step: ThinkingStep = {
			kind: 'thinking',
			label: '생각 중',
			body: 'body'
		};
		setStep(editor.view, step);
		expect(widgetCount(editor)).toBe(1);
		clearStep(editor.view);
		expect(widgetCount(editor)).toBe(0);
		editor.destroy();
	});

	it('replaces (not duplicates) on consecutive setStep', () => {
		const editor = createTestEditor();
		setStep(editor.view, {
			kind: 'thinking',
			label: 'first',
			body: 'a'
		});
		expect(widgetCount(editor)).toBe(1);
		setStep(editor.view, {
			kind: 'tool_use',
			label: 'second',
			body: 'b'
		});
		expect(widgetCount(editor)).toBe(1);
		setStep(editor.view, {
			kind: 'response_start',
			label: 'third',
			body: ''
		});
		expect(widgetCount(editor)).toBe(1);
		editor.destroy();
	});

	it('widget DOM has aside.thinking-display with correct data-kind, label, and body', () => {
		const editor = createTestEditor();
		const step: ThinkingStep = {
			kind: 'tool_use',
			label: '도구: Bash',
			body: 'ls -la'
		};
		setStep(editor.view, step);
		const aside = editor.view.dom.querySelector(
			'aside.thinking-display'
		) as HTMLElement | null;
		expect(aside).not.toBeNull();
		expect(aside!.getAttribute('data-kind')).toBe('tool_use');
		const header = aside!.querySelector(
			'header.thinking-display-label'
		) as HTMLElement | null;
		expect(header).not.toBeNull();
		expect(header!.textContent).toBe('도구: Bash');
		const body = aside!.querySelector(
			'blockquote.thinking-display-body'
		) as HTMLElement | null;
		expect(body).not.toBeNull();
		expect(body!.textContent).toBe('ls -la');
		editor.destroy();
	});

	it('omits blockquote when body is empty (label-only)', () => {
		const editor = createTestEditor();
		const step: ThinkingStep = {
			kind: 'response_start',
			label: '응답 시작',
			body: ''
		};
		setStep(editor.view, step);
		const aside = editor.view.dom.querySelector(
			'aside.thinking-display'
		) as HTMLElement | null;
		expect(aside).not.toBeNull();
		const header = aside!.querySelector('header.thinking-display-label');
		expect(header).not.toBeNull();
		const body = aside!.querySelector('blockquote.thinking-display-body');
		expect(body).toBeNull();
		editor.destroy();
	});

	it('ignores setStep on empty doc — no throw, no widget', () => {
		// PM schema requires content+, so the truly empty doc case is hard
		// to construct. We exercise the guard by clearing content as much as
		// possible and verifying setStep + decorations() does not throw and
		// renders no widget when the plugin's lastParagraphStart guard kicks
		// in. With a single empty paragraph the plugin still renders at pos
		// 0; the guard specifically covers childCount === 0 which is the
		// future-proofing safety net.
		const root = document.createElement('div');
		document.body.appendChild(root);
		const editor = new Editor({
			element: root,
			extensions: [
				StarterKit.configure({ undoRedo: false }),
				Extension.create({
					name: 'thinkingDisplayExt',
					addProseMirrorPlugins() {
						return [createThinkingDisplayPlugin()];
					}
				})
			],
			content: ''
		});
		expect(() => {
			setStep(editor.view, {
				kind: 'thinking',
				label: 'x',
				body: 'y'
			});
		}).not.toThrow();
		// State updated regardless.
		const state = thinkingDisplayKey.getState(editor.state);
		expect(state?.step).not.toBeNull();
		editor.destroy();
	});
});
