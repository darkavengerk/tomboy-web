import type { Editor } from '@tiptap/core';

export function formatDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

export function insertTodayDate(editor: Editor, now: Date = new Date()): void {
	const text = formatDate(now);
	editor
		.chain()
		.focus()
		.insertContent({ type: 'text', text, marks: [{ type: 'tomboyDatetime' }] })
		.unsetMark('tomboyDatetime')
		.run();
}
