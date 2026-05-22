import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { JSONContent } from '@tiptap/core';
import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';

vi.mock('$lib/remarkable/applyWallpaper.js', async (orig) => {
	const actual = await orig<typeof import('$lib/remarkable/applyWallpaper.js')>();
	return { ...actual, applyWallpaper: vi.fn() };
});
import { applyWallpaper, WallpaperApplyError } from '$lib/remarkable/applyWallpaper.js';

function fakeEditor(doc: JSONContent) {
	return {
		getJSON: () => doc,
		on: () => {},
		off: () => {}
	} as unknown as import('@tiptap/core').Editor;
}

function para(text: string): JSONContent {
	return { type: 'paragraph', content: text === '' ? undefined : [{ type: 'text', text }] };
}

const rmDoc: JSONContent = {
	type: 'doc',
	content: [para('내 배경'), para('remarkable://rm2'), para('절전 중:'), para('https://x/sleep.png')]
};

afterEach(() => {
	vi.clearAllMocks();
});

describe('RemarkableActionBar', () => {
	it('renders nothing for a non-remarkable note', () => {
		const { container } = render(RemarkableActionBar, {
			editor: fakeEditor({ type: 'doc', content: [para('보통 노트')] }),
			bridgeUrl: 'wss://b',
			bridgeToken: 't'
		});
		expect(container.textContent).not.toContain('리마커블 배경화면');
	});

	it('renders host + slot label for a remarkable note', () => {
		render(RemarkableActionBar, { editor: fakeEditor(rmDoc), bridgeUrl: 'wss://b', bridgeToken: 't' });
		expect(screen.getByText('리마커블 배경화면')).toBeTruthy();
		expect(screen.getByText('rm2')).toBeTruthy();
		expect(screen.getByText('절전 중')).toBeTruthy();
	});

	it('applies wallpaper on button click and shows ok status', async () => {
		vi.mocked(applyWallpaper).mockResolvedValue([{ slot: 'suspended', status: 'ok' }]);
		render(RemarkableActionBar, { editor: fakeEditor(rmDoc), bridgeUrl: 'wss://b', bridgeToken: 't' });
		await fireEvent.click(screen.getByRole('button', { name: '적용' }));
		expect(applyWallpaper).toHaveBeenCalledWith(
			expect.objectContaining({ host: 'rm2', screens: [{ slot: 'suspended', imageUrl: 'https://x/sleep.png' }] })
		);
		await screen.findByText('절전 중');
		const slotEl = screen.getByText('절전 중').closest('[data-status]');
		expect(slotEl?.getAttribute('data-status')).toBe('ok');
	});

	it('marks all slots error when applyWallpaper throws', async () => {
		vi.mocked(applyWallpaper).mockRejectedValue(
			new WallpaperApplyError('network', '브릿지에 연결할 수 없습니다')
		);
		render(RemarkableActionBar, { editor: fakeEditor(rmDoc), bridgeUrl: 'wss://b', bridgeToken: 't' });
		await fireEvent.click(screen.getByRole('button', { name: '적용' }));
		await vi.waitFor(() => {
			const el = screen.getByText('절전 중').closest('[data-status]');
			expect(el?.getAttribute('data-status')).toBe('error');
		});
	});

	it('shows empty notice when there are no slots', () => {
		render(RemarkableActionBar, {
			editor: fakeEditor({ type: 'doc', content: [para('내 배경'), para('remarkable://rm2')] }),
			bridgeUrl: 'wss://b',
			bridgeToken: 't'
		});
		expect(screen.getByText(/적용할 화면이 없습니다/)).toBeTruthy();
		expect((screen.getByRole('button', { name: '적용' }) as HTMLButtonElement).disabled).toBe(true);
	});
});
