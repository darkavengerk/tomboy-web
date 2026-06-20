import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import DiaryOcrSettings from '$lib/remarkable/DiaryOcrSettings.svelte';

vi.mock('$lib/storage/appSettings.js', () => ({
	getDiaryTriggerUrl: vi.fn(async () => ''),
	getDiaryTriggerToken: vi.fn(async () => '')
}));

afterEach(() => vi.restoreAllMocks());

describe('DiaryOcrSettings', () => {
	it('renders the section heading without a configured trigger', async () => {
		const { findByText } = render(DiaryOcrSettings);
		expect(await findByText(/일기 OCR 파이프라인 설정/)).toBeTruthy();
	});
});
