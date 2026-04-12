import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import TopNav from '$lib/components/TopNav.svelte';
import { appMode } from '$lib/stores/appMode.svelte.js';

describe('TopNav', () => {
	beforeEach(() => {
		appMode.set('home');
	});

	it('홈/슬립노트/전체 링크가 렌더된다', () => {
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByRole('link', { name: '홈' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: '슬립노트' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: '전체' })).toBeInTheDocument();
	});

	it('뒤로가기 버튼은 canGoBack=false일 때 비활성화', () => {
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByLabelText('뒤로가기')).toBeDisabled();
	});

	it('앞으로가기 버튼은 canGoForward=false일 때 비활성화', () => {
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByLabelText('앞으로가기')).toBeDisabled();
	});

	it('뒤로가기 클릭 시 onback 콜백 호출', async () => {
		const user = userEvent.setup();
		const onback = vi.fn();
		render(TopNav, { canGoBack: true, canGoForward: false, onback });
		await user.click(screen.getByLabelText('뒤로가기'));
		expect(onback).toHaveBeenCalledOnce();
	});

	it('앞으로가기 클릭 시 onforward 콜백 호출', async () => {
		const user = userEvent.setup();
		const onforward = vi.fn();
		render(TopNav, { canGoBack: false, canGoForward: true, onforward });
		await user.click(screen.getByLabelText('앞으로가기'));
		expect(onforward).toHaveBeenCalledOnce();
	});

	it('appMode=home 일 때 홈 링크가 active', () => {
		appMode.set('home');
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('link', { name: '전체' })).not.toHaveAttribute('aria-current', 'page');
	});

	it('appMode=notes 일 때 전체 링크가 active', () => {
		appMode.set('notes');
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByRole('link', { name: '전체' })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('link', { name: '홈' })).not.toHaveAttribute('aria-current', 'page');
	});

	it('appMode=sleepnote 일 때 슬립노트 링크가 active', () => {
		appMode.set('sleepnote');
		render(TopNav, { canGoBack: false, canGoForward: false });
		expect(screen.getByRole('link', { name: '슬립노트' })).toHaveAttribute('aria-current', 'page');
	});
});
