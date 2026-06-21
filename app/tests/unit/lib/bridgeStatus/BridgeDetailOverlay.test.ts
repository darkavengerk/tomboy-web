import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/svelte';

vi.mock('$lib/bridgeStatus/statusClient.js', async (orig) => {
	const actual = (await orig()) as object;
	return { ...actual, fetchBridgeDetail: vi.fn() };
});

import BridgeDetailOverlay from '$lib/bridgeStatus/detail/BridgeDetailOverlay.svelte';
import { fetchBridgeDetail } from '$lib/bridgeStatus/statusClient.js';

afterEach(() => cleanup());

const sample = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: { count: 1, newest_mtime: '2026-06-21T04:44:00Z', stale_minutes: 1, per_folder: [{ folder: 'Diary', count: 1, newest_mtime: null }] },
	ocr: { status: 'unconfigured' }
};

describe('BridgeDetailOverlay', () => {
	it('fetches and renders the registered view; title shown', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockResolvedValue(sample);
		const { getByText } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose: () => {} });
		await waitFor(() => expect(getByText('📓 일기 파이프라인')).toBeTruthy());
		expect(getByText('Diary')).toBeTruthy();
	});

	it('shows korean error on failure', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error('x'), { kind: 'network' })
		);
		const { getByText } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose: () => {} });
		await waitFor(() => expect(getByText('브릿지에 연결할 수 없습니다')).toBeTruthy());
	});

	it('backdrop click calls onclose', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockResolvedValue(sample);
		const onclose = vi.fn();
		const { container } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose });
		const backdrop = container.querySelector('.bridge-detail-backdrop')!;
		await fireEvent.click(backdrop);
		expect(onclose).toHaveBeenCalled();
	});
});
