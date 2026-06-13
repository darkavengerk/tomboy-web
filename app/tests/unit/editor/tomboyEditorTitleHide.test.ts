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

afterEach(() => cleanup());

const content = { type: 'doc', content: [
	{ type: 'paragraph', content: [{ type: 'text', text: '타이틀' }] },
	{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }
]};

describe('TomboyEditor hideTitleLine', () => {
	it('hideTitleLine=true 면 첫 문단을 숨긴다', async () => {
		const { container } = render(TomboyEditor, { props: { content, currentGuid: 'g1', hideTitleLine: true } });
		await new Promise((r) => setTimeout(r, 100));
		const firstP = container.querySelector('.ProseMirror p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(true);
	});

	it('기본값에서는 숨기지 않는다', async () => {
		const { container } = render(TomboyEditor, { props: { content, currentGuid: 'g2' } });
		await new Promise((r) => setTimeout(r, 100));
		const firstP = container.querySelector('.ProseMirror p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(false);
	});
});
