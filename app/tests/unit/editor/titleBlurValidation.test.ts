import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';

// Controllable title→guid map used by the mocked titleProvider.
const titles = new Map<string, string>();
const ensureTitleIndexReadyMock = vi.fn(async () => {});

vi.mock('$lib/editor/autoLink/titleProvider.js', () => ({
	lookupGuidByTitle: (t: string) => titles.get(t.trim()) ?? null,
	ensureTitleIndexReady: () => ensureTitleIndexReadyMock(),
	createTitleProvider: () => ({
		getTitles: () => [],
		refresh: async () => {},
		onChange: () => () => {},
		dispose: () => {}
	})
}));

import { handleTitleBlur } from '$lib/editor/titleUniqueGuard.js';

let currentEditor: Editor | null = null;

function makeEditor(content: unknown): Editor {
	const ed = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: content as never
	});
	currentEditor = ed;
	return ed;
}

beforeEach(() => {
	titles.clear();
	ensureTitleIndexReadyMock.mockClear();
});

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('handleTitleBlur', () => {
	it('does not toast or move cursor when the title is empty', async () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'body' }] }]
		});
		const pushToast = vi.fn();
		const latch = { current: null as string | null };

		const out = await handleTitleBlur(editor, 'me', pushToast, latch);

		expect(out).toEqual({ blocked: false });
		expect(pushToast).not.toHaveBeenCalled();
		expect(latch.current).toBeNull();
	});

	it('does not toast when the title maps to the current note (self)', async () => {
		titles.set('Mine', 'me');
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Mine' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		const pushToast = vi.fn();
		const latch = { current: 'stale' as string | null };

		const out = await handleTitleBlur(editor, 'me', pushToast, latch);

		expect(out).toEqual({ blocked: false });
		expect(pushToast).not.toHaveBeenCalled();
		// Latch should be cleared when conflict resolves.
		expect(latch.current).toBeNull();
	});

	it('does not toast when the title is not present anywhere', async () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Brand New' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		const pushToast = vi.fn();
		const latch = { current: 'old' as string | null };

		const out = await handleTitleBlur(editor, 'me', pushToast, latch);

		expect(out).toEqual({ blocked: false });
		expect(pushToast).not.toHaveBeenCalled();
		expect(latch.current).toBeNull();
	});

	it('toasts, moves cursor, and focuses when the title collides with another note', async () => {
		titles.set('Existing', 'other-guid');
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		const pushToast = vi.fn();
		const latch = { current: null as string | null };

		// Move the cursor into the body so we can verify it's put back in the title.
		editor.commands.focus();
		editor.commands.setTextSelection(editor.state.doc.content.size);
		const posBeforeBlur = editor.state.selection.from;
		expect(posBeforeBlur).toBeGreaterThan(0);

		const out = await handleTitleBlur(editor, 'me', pushToast, latch);

		expect(out).toEqual({ blocked: true });
		expect(pushToast).toHaveBeenCalledTimes(1);
		const [msg, opts] = pushToast.mock.calls[0];
		expect(msg).toBe('이미 "Existing" 이라는 제목의 노트가 있습니다. 제목을 수정해 주세요.');
		expect(opts).toEqual({ kind: 'error' });

		// Cursor should now be at title end pos.
		const expectedEnd =
			(editor.state.doc.firstChild?.nodeSize ?? 1) - 1;
		expect(editor.state.selection.from).toBe(expectedEnd);

		// Latch set to the title.
		expect(latch.current).toBe('Existing');

		// ensureTitleIndexReady should have been awaited.
		expect(ensureTitleIndexReadyMock).toHaveBeenCalled();
	});

	it('does not re-toast on repeated blur with the same conflicting title (latch)', async () => {
		titles.set('Existing', 'other-guid');
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		const pushToast = vi.fn();
		const latch = { current: null as string | null };

		const first = await handleTitleBlur(editor, 'me', pushToast, latch);
		expect(first).toEqual({ blocked: true });
		expect(pushToast).toHaveBeenCalledTimes(1);

		// Simulate cursor having moved into body between blurs.
		editor.commands.setTextSelection(editor.state.doc.content.size);

		const second = await handleTitleBlur(editor, 'me', pushToast, latch);
		expect(second).toEqual({ blocked: true });
		// Still just the one toast total.
		expect(pushToast).toHaveBeenCalledTimes(1);

		// Cursor still moved back to title end.
		const expectedEnd =
			(editor.state.doc.firstChild?.nodeSize ?? 1) - 1;
		expect(editor.state.selection.from).toBe(expectedEnd);
	});

	it('re-toasts when a different conflicting title is entered', async () => {
		titles.set('First', 'guid-a');
		titles.set('Second', 'guid-b');
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		const pushToast = vi.fn();
		const latch = { current: null as string | null };

		await handleTitleBlur(editor, 'me', pushToast, latch);
		expect(pushToast).toHaveBeenCalledTimes(1);
		expect(latch.current).toBe('First');

		// User changes the title to a DIFFERENT conflicting title.
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});

		await handleTitleBlur(editor, 'me', pushToast, latch);
		expect(pushToast).toHaveBeenCalledTimes(2);
		expect(latch.current).toBe('Second');
	});
});
