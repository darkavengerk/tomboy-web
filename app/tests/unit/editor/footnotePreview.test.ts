import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { FootnotePreview } from '$lib/editor/footnote/preview.js';

let preview: FootnotePreview;
let anchor: HTMLElement;

beforeEach(() => {
	preview = new FootnotePreview();
	anchor = document.createElement('span');
	document.body.appendChild(anchor);
});

afterEach(() => {
	preview.hide();
	anchor.remove();
	document
		.querySelectorAll('.tomboy-fn-preview')
		.forEach((el) => el.remove());
	vi.useRealTimers();
});

describe('FootnotePreview', () => {
	it('show 가 본문 텍스트를 가진 팝오버를 document.body 에 추가한다', () => {
		preview.show(anchor, '설명 내용', { withJumpButton: false });
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.textContent).toContain('설명 내용');
	});

	it('withJumpButton:false 면 버튼이 없고 static 클래스가 붙는다', () => {
		preview.show(anchor, '설명', { withJumpButton: false });
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
		expect(
			document
				.querySelector('.tomboy-fn-preview')!
				.classList.contains('tomboy-fn-preview-static')
		).toBe(true);
	});

	it('withJumpButton:true 면 이동 버튼 클릭이 onJump 를 부르고 팝오버를 닫는다', () => {
		const onJump = vi.fn();
		preview.show(anchor, '설명', { withJumpButton: true, onJump });
		const btn = document.querySelector(
			'.tomboy-fn-preview-jump'
		) as HTMLButtonElement;
		expect(btn).not.toBeNull();
		btn.click();
		expect(onJump).toHaveBeenCalledOnce();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});

	it('missing:true 면 missing 클래스가 붙고 버튼이 없다', () => {
		preview.show(anchor, '설명을 찾을 수 없습니다', {
			withJumpButton: true,
			missing: true
		});
		const el = document.querySelector('.tomboy-fn-preview')!;
		expect(el.classList.contains('tomboy-fn-preview-missing')).toBe(true);
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
	});

	it('hide 가 요소를 제거하고, show 재호출이 이전 요소를 치운다', () => {
		preview.show(anchor, '첫 번째', { withJumpButton: false });
		preview.show(anchor, '두 번째', { withJumpButton: false });
		expect(document.querySelectorAll('.tomboy-fn-preview')).toHaveLength(1);
		expect(document.querySelector('.tomboy-fn-preview')!.textContent).toContain(
			'두 번째'
		);
		preview.hide();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});

	it('모바일 팝오버는 바깥 pointerdown 에 닫힌다', () => {
		vi.useFakeTimers();
		preview.show(anchor, '설명', { withJumpButton: true, onJump: () => {} });
		vi.runAllTimers(); // 닫힘 리스너 등록(0ms setTimeout)
		document.body.dispatchEvent(
			new Event('pointerdown', { bubbles: true })
		);
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});
});
