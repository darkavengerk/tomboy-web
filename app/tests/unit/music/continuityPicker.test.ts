import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import MusicContinuityPicker from '$lib/editor/musicNote/MusicContinuityPicker.svelte';

describe('MusicContinuityPicker', () => {
	it('renders both options and emits onpick', async () => {
		const onpick = vi.fn();
		const { getByText } = render(MusicContinuityPicker, {
			props: { localTitle: '로컬곡', remoteTitle: '리모트곡', remoteDeviceName: '아이폰', onpick, oncancel: () => {} }
		});
		expect(getByText('로컬곡')).toBeTruthy();
		expect(getByText('아이폰에서 듣던 곡')).toBeTruthy();
		await fireEvent.click(getByText('리모트곡'));
		expect(onpick).toHaveBeenCalledWith('remote');
	});

	it('renders local label and fires onpick with local when local option is clicked', async () => {
		const onpick = vi.fn();
		const { getByText } = render(MusicContinuityPicker, {
			props: { localTitle: '내 곡', remoteTitle: '상대 곡', remoteDeviceName: '아이패드', onpick, oncancel: () => {} }
		});
		expect(getByText('이 기기에서 듣던 곡')).toBeTruthy();
		await fireEvent.click(getByText('내 곡'));
		expect(onpick).toHaveBeenCalledWith('local');
	});

	it('fires oncancel when cancel button is clicked', async () => {
		const oncancel = vi.fn();
		const { getByText } = render(MusicContinuityPicker, {
			props: { localTitle: '로컬곡', remoteTitle: '리모트곡', remoteDeviceName: '맥북', onpick: () => {}, oncancel }
		});
		await fireEvent.click(getByText('취소'));
		expect(oncancel).toHaveBeenCalled();
	});
});
