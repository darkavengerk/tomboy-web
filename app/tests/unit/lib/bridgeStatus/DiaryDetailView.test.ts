import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DiaryDetailView from '$lib/bridgeStatus/detail/DiaryDetailView.svelte';
import type { DiaryDetail } from '$lib/bridgeStatus/statusClient.js';

afterEach(() => cleanup());

const base: DiaryDetail = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: {
		count: 3,
		newest_mtime: '2026-06-21T04:44:00Z',
		stale_minutes: 5,
		per_folder: [
			{ folder: 'Diary', count: 2, newest_mtime: '2026-06-21T04:44:00Z' },
			{ folder: 'Slip-Notes', count: 1, newest_mtime: '2026-06-21T04:40:00Z' }
		]
	},
	ocr: { status: 'unconfigured' }
};

describe('DiaryDetailView', () => {
	it('renders folder backlog rows and counts', () => {
		const { getByText, container } = render(DiaryDetailView, { detail: base });
		expect(getByText('Diary')).toBeTruthy();
		expect(getByText('Slip-Notes')).toBeTruthy();
		expect(container.querySelectorAll('.folder-bar').length).toBe(2);
	});

	it('marks stale badge ok when fresh', () => {
		const { container } = render(DiaryDetailView, { detail: base });
		expect(container.querySelector('.stale-badge.ok')).toBeTruthy();
	});

	it('marks stale badge crit when very stale', () => {
		const d = { ...base, inbox: { ...base.inbox, stale_minutes: 300 } };
		const { container } = render(DiaryDetailView, { detail: d });
		expect(container.querySelector('.stale-badge.crit')).toBeTruthy();
	});

	it('shows ok OCR result with summary', () => {
		const d: DiaryDetail = {
			...base,
			ocr: {
				status: 'ok',
				result: 'success',
				last_run_at: '2026-06-21T04:45:00Z',
				exit_code: 0,
				summary: 'Push complete: 2 page(s) sent',
				log_tail: 'line1\nline2'
			}
		};
		const { getByText } = render(DiaryDetailView, { detail: d });
		expect(getByText(/Push complete: 2/)).toBeTruthy();
	});
});
