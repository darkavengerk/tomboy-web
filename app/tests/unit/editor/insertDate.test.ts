import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyDatetime } from '$lib/editor/extensions/TomboyDatetime.js';
import { formatDate, insertTodayDate } from '$lib/editor/insertDate.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false }),
			TomboyDatetime
		],
		content: { type: 'doc', content: [{ type: 'paragraph' }] }
	});
	currentEditor = editor;
	return editor;
}

describe('formatDate', () => {
	it('returns yyyy-mm-dd zero-padded', () => {
		expect(formatDate(new Date(2026, 3, 15))).toBe('2026-04-15');
	});

	it('pads single-digit month and day', () => {
		expect(formatDate(new Date(2024, 0, 1))).toBe('2024-01-01');
	});

	it('handles December (12) and 31 without dropping digits', () => {
		expect(formatDate(new Date(1999, 11, 31))).toBe('1999-12-31');
	});

	it('uses local time, not UTC (no day shift near midnight)', () => {
		// 2026-04-15 23:59:59 local should still be 2026-04-15
		expect(formatDate(new Date(2026, 3, 15, 23, 59, 59))).toBe('2026-04-15');
	});
});

describe('insertTodayDate', () => {
	it('inserts yyyy-mm-dd text at the cursor', () => {
		const editor = makeEditor();
		insertTodayDate(editor, new Date(2026, 3, 15));
		expect(editor.getText()).toBe('2026-04-15');
	});

	it('wraps the inserted date in a tomboyDatetime mark', () => {
		const editor = makeEditor();
		insertTodayDate(editor, new Date(2026, 3, 15));

		const json = editor.getJSON();
		const para = json.content?.[0];
		const text = para?.content?.[0];
		expect(text?.type).toBe('text');
		expect(text?.text).toBe('2026-04-15');
		const marks = text?.marks ?? [];
		expect(marks.some((m) => m.type === 'tomboyDatetime')).toBe(true);
	});

	it('moves the cursor to the end of the inserted text (mark not active for next typed chars)', () => {
		const editor = makeEditor();
		insertTodayDate(editor, new Date(2026, 3, 15));
		// Append " hello" — should not extend the datetime mark
		editor.commands.insertContent(' hello');

		const json = editor.getJSON();
		const para = json.content?.[0];
		const items = para?.content ?? [];
		const last = items[items.length - 1];
		const lastMarks = last?.marks ?? [];
		expect(lastMarks.some((m) => m.type === 'tomboyDatetime')).toBe(false);
		expect(editor.getText()).toBe('2026-04-15 hello');
	});
});
