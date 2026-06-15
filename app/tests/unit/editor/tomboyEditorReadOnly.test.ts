import { describe, it, expect, afterEach } from 'vitest';
// TomboyEditor's onMount warms the title index via IDB (listNotesShared →
// getAllNotes); without this the mount emits "indexedDB is not defined"
// unhandled rejections that pollute the suite output.
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import TomboyEditor from '$lib/editor/TomboyEditor.svelte';

// jsdom lacks ResizeObserver (used by StickyHeader inside TomboyEditor).
class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

afterEach(() => cleanup());

describe('TomboyEditor readOnly', () => {
	it('is editable by default', async () => {
		const { container } = render(TomboyEditor, { props: { content } });
		await new Promise((r) => setTimeout(r, 100));
		const pm = container.querySelector('.ProseMirror');
		expect(pm?.getAttribute('contenteditable')).toBe('true');
	});

	it('is not editable when readOnly', async () => {
		const { container } = render(TomboyEditor, { props: { content, readOnly: true } });
		await new Promise((r) => setTimeout(r, 100));
		const pm = container.querySelector('.ProseMirror');
		expect(pm?.getAttribute('contenteditable')).toBe('false');
	});
});
