import { describe, it, expect } from 'vitest';
import { dragStartAllowed } from '$lib/editor/musicNote/miniPlayerDrag.js';

/**
 * 미니 플레이어 드래그 가드 — 버그 재현:
 * 알약/그립 전체에 onpointerdown→setPointerCapture 를 걸면, 자식 버튼(✕/▶)에서 시작한
 * 포인터 이벤트도 캡처되어 이후 click 이 캡처 요소로 재타게팅 → 버튼 onclick 이 영영
 * 발화하지 않는다(✕ 눌러도 안 닫힘). 버튼에서 시작한 pointerdown 은 드래그를 시작하면
 * 안 된다.
 */
describe('dragStartAllowed', () => {
	function build(): { grip: HTMLElement; xBtn: HTMLButtonElement; label: HTMLElement } {
		const grip = document.createElement('div');
		const label = document.createElement('span');
		label.textContent = '♪ 재생 중';
		const xBtn = document.createElement('button');
		const inner = document.createElement('span');
		inner.textContent = '✕';
		xBtn.appendChild(inner);
		grip.appendChild(label);
		grip.appendChild(xBtn);
		return { grip, xBtn, label };
	}

	it('버튼에서 시작한 pointerdown 은 드래그 금지', () => {
		const { xBtn } = build();
		expect(dragStartAllowed(xBtn)).toBe(false);
	});

	it('버튼 내부 자식 노드에서 시작해도 드래그 금지', () => {
		const { xBtn } = build();
		expect(dragStartAllowed(xBtn.firstChild)).toBe(false);
	});

	it('그립의 비인터랙티브 영역(라벨/그립 자체)은 드래그 허용', () => {
		const { grip, label } = build();
		expect(dragStartAllowed(grip)).toBe(true);
		expect(dragStartAllowed(label)).toBe(true);
	});

	it('input(시크바 등)에서 시작해도 드래그 금지', () => {
		const input = document.createElement('input');
		expect(dragStartAllowed(input)).toBe(false);
	});

	it('null/비 Element 타깃은 드래그 허용(보수적 기본)', () => {
		expect(dragStartAllowed(null)).toBe(true);
	});
});
