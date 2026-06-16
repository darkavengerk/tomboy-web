import { describe, it, expect } from 'vitest';
import { miniPlayerVisible } from '$lib/editor/musicNote/miniPlayerVisibility.js';

describe('miniPlayerVisible (모바일)', () => {
	it('활성 노트가 현재 페이지가 아니면 표시', () => {
		expect(miniPlayerVisible('A', 2, 'B')).toBe(true);
		expect(miniPlayerVisible('A', 2, null)).toBe(true);
	});
	it('현재 페이지가 활성 노트면 숨김(인-노트 바가 담당)', () => {
		expect(miniPlayerVisible('A', 2, 'A')).toBe(false);
	});
	it('활성 없음/빈 큐면 숨김', () => {
		expect(miniPlayerVisible(null, 0, 'B')).toBe(false);
		expect(miniPlayerVisible('A', 0, 'B')).toBe(false);
	});
});
