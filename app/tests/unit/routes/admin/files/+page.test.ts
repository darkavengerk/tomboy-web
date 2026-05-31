import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

vi.mock('$lib/sync/bridgeFileAdmin.js', () => ({
	listBridgeFiles: vi.fn(),
	deleteBridgeFile: vi.fn()
}));

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'wss://bridge.example.com'),
	bridgeToHttpBase: (b: string) => 'https://bridge.example.com'
}));

vi.mock('$lib/stores/toast.js', () => ({
	pushToast: vi.fn(),
	dismissToast: vi.fn()
}));

import Page from '../../../../../src/routes/admin/files/+page.svelte';
import { listBridgeFiles, deleteBridgeFile } from '$lib/sync/bridgeFileAdmin.js';
import { pushToast } from '$lib/stores/toast.js';

beforeEach(() => {
	vi.mocked(listBridgeFiles).mockReset();
	vi.mocked(deleteBridgeFile).mockReset();
	vi.mocked(pushToast).mockReset();
	vi.stubGlobal('confirm', () => true);
});

describe('/admin/files page', () => {
	it('빈 목록이면 안내 문구를 보여준다', async () => {
		vi.mocked(listBridgeFiles).mockResolvedValue([]);
		render(Page);
		await waitFor(() => {
			expect(screen.getByText(/파일이 없습니다/)).toBeTruthy();
		});
		expect(listBridgeFiles).toHaveBeenCalledTimes(1);
	});

	it('파일 목록을 테이블로 렌더링한다', async () => {
		vi.mocked(listBridgeFiles).mockResolvedValue([
			{ uuid: 'aaa-111', filename: 'report.pdf', size: 2048, mtime: '2026-05-29T10:00:00Z' },
			{ uuid: 'bbb-222', filename: 'photo.png', size: 5_120_000, mtime: '2026-05-28T09:00:00Z' }
		]);
		render(Page);
		await waitFor(() => {
			expect(screen.getByText('report.pdf')).toBeTruthy();
			expect(screen.getByText('photo.png')).toBeTruthy();
		});
	});

	it('검색어로 파일 이름을 필터링한다', async () => {
		vi.mocked(listBridgeFiles).mockResolvedValue([
			{ uuid: 'aaa-111', filename: 'report.pdf', size: 2048, mtime: '2026-05-29T10:00:00Z' },
			{ uuid: 'bbb-222', filename: 'photo.png', size: 5_120_000, mtime: '2026-05-28T09:00:00Z' }
		]);
		render(Page);
		await waitFor(() => {
			expect(screen.getByText('report.pdf')).toBeTruthy();
		});
		const search = screen.getByPlaceholderText(/파일 이름 검색/) as HTMLInputElement;
		await fireEvent.input(search, { target: { value: 'photo' } });
		await waitFor(() => {
			expect(screen.queryByText('report.pdf')).toBeNull();
			expect(screen.getByText('photo.png')).toBeTruthy();
		});
	});

	it('삭제 버튼은 deleteBridgeFile을 호출하고 목록을 다시 불러온다', async () => {
		vi.mocked(listBridgeFiles)
			.mockResolvedValueOnce([
				{ uuid: 'aaa-111', filename: 'report.pdf', size: 2048, mtime: '2026-05-29T10:00:00Z' }
			])
			.mockResolvedValueOnce([]);
		vi.mocked(deleteBridgeFile).mockResolvedValue(undefined);
		render(Page);
		await waitFor(() => {
			expect(screen.getByText('report.pdf')).toBeTruthy();
		});
		const delBtn = screen.getByRole('button', { name: '삭제' });
		await fireEvent.click(delBtn);
		await waitFor(() => {
			expect(deleteBridgeFile).toHaveBeenCalledWith('aaa-111');
		});
		await waitFor(() => {
			expect(listBridgeFiles).toHaveBeenCalledTimes(2);
		});
	});
});
