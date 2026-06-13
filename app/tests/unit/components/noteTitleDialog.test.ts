import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';

afterEach(() => cleanup());

describe('NoteTitleDialog', () => {
	it('타이틀이 비면 확정 비활성, 입력하면 활성', async () => {
		const { getByRole, getByLabelText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: [], initialTitle: '', initialNotebook: null,
				onsubmit: () => {}, oncancel: () => {} }
		});
		const submit = getByRole('button', { name: '만들기' }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		await fireEvent.input(getByLabelText('타이틀'), { target: { value: '메모' } });
		expect(submit.disabled).toBe(false);
	});

	it('확정 시 입력값을 넘긴다', async () => {
		const onsubmit = vi.fn();
		const { getByRole, getByLabelText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: ['업무'], initialTitle: '', initialNotebook: null,
				onsubmit, oncancel: () => {} }
		});
		await fireEvent.input(getByLabelText('타이틀'), { target: { value: '서버' } });
		await fireEvent.click(getByRole('button', { name: '만들기' }));
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ title: '서버', typeId: 'plain' }));
	});

	it('progressStages 가 있으면 진행 뷰', () => {
		const { queryByLabelText, getByText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: [], initialTitle: '', initialNotebook: null,
				onsubmit: () => {}, oncancel: () => {},
				progressStages: [{ name: '노트 생성', ms: 12, status: 'done' }] }
		});
		expect(queryByLabelText('타이틀')).toBeNull();
		expect(getByText('노트 생성')).toBeTruthy();
		expect(getByText(/12\s*ms/)).toBeTruthy();
	});
});
