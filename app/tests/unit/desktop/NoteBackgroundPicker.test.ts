import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

// Mock the image cache so the picker's grid + thumbnail loading is deterministic.
vi.mock('$lib/imageCache/imageCache.js', () => ({
	listCached: vi.fn(),
	getBlob: vi.fn()
}));

import { listCached, getBlob } from '$lib/imageCache/imageCache.js';
import NoteBackgroundPicker from '$lib/desktop/NoteBackgroundPicker.svelte';

const listCachedMock = listCached as unknown as ReturnType<typeof vi.fn>;
const getBlobMock = getBlob as unknown as ReturnType<typeof vi.fn>;

function baseProps(over: Record<string, unknown> = {}) {
	return {
		anchor: { right: 10, bottom: 10 },
		onapply: vi.fn(),
		onclose: vi.fn(),
		...over
	};
}

function cachedInfo(url: string, lastAccess: number) {
	return { url, size: 10, contentType: 'image/png', lastAccess };
}

beforeEach(() => {
	vi.clearAllMocks();
	listCachedMock.mockResolvedValue([]);
	getBlobMock.mockResolvedValue(new Blob([new Uint8Array(4)], { type: 'image/png' }));
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('NoteBackgroundPicker', () => {
	it('renders URL input, 적용 button, and the 5 display modes', () => {
		const { getByPlaceholderText, getByText } = render(NoteBackgroundPicker, {
			props: baseProps()
		});
		expect(getByPlaceholderText(/이미지 URL/)).toBeTruthy();
		expect(getByText('적용')).toBeTruthy();
		for (const label of ['채우기', '맞춤', '확대', '가운데', '바둑판식']) {
			expect(getByText(label)).toBeTruthy();
		}
	});

	it('적용 with a URL emits onapply({kind:url}) with the default mode cover', async () => {
		const onapply = vi.fn();
		const { getByPlaceholderText, getByText } = render(NoteBackgroundPicker, {
			props: baseProps({ onapply })
		});
		await fireEvent.input(getByPlaceholderText(/이미지 URL/), {
			target: { value: 'https://x/a.png' }
		});
		await fireEvent.click(getByText('적용'));
		expect(onapply).toHaveBeenCalledWith({ kind: 'url', url: 'https://x/a.png' }, 'cover');
	});

	it('적용 with an empty URL does nothing', async () => {
		const onapply = vi.fn();
		const { getByText } = render(NoteBackgroundPicker, { props: baseProps({ onapply }) });
		await fireEvent.click(getByText('적용'));
		expect(onapply).not.toHaveBeenCalled();
	});

	it('selecting a mode changes the mode passed to onapply', async () => {
		const onapply = vi.fn();
		const { getByPlaceholderText, getByText } = render(NoteBackgroundPicker, {
			props: baseProps({ onapply })
		});
		await fireEvent.click(getByText('맞춤')); // contain
		await fireEvent.input(getByPlaceholderText(/이미지 URL/), {
			target: { value: 'https://x/a.png' }
		});
		await fireEvent.click(getByText('적용'));
		expect(onapply).toHaveBeenCalledWith({ kind: 'url', url: 'https://x/a.png' }, 'contain');
	});

	it('clicking a cached thumbnail emits onapply({kind:cache}) with the selected mode', async () => {
		listCachedMock.mockResolvedValue([cachedInfo('https://a/1.png', 2)]);
		const onapply = vi.fn();
		const { findByRole } = render(NoteBackgroundPicker, { props: baseProps({ onapply }) });
		const thumb = await findByRole('button', { name: 'https://a/1.png' });
		await fireEvent.click(thumb);
		expect(onapply).toHaveBeenCalledWith({ kind: 'cache', url: 'https://a/1.png' }, 'cover');
	});

	it('caps the grid at 60 thumbnails and announces the truncation', async () => {
		const many = Array.from({ length: 70 }, (_, i) => cachedInfo(`https://a/${i}.png`, 70 - i));
		listCachedMock.mockResolvedValue(many);
		const { findByText } = render(NoteBackgroundPicker, { props: baseProps() });
		expect(await findByText(/총 70개 중 60개 표시/)).toBeTruthy();
		// portal mounts the picker on document.body, not the render container
		expect(document.querySelectorAll('.thumb')).toHaveLength(60);
	});
});
