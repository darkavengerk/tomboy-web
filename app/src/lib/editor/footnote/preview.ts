/**
 * 각주 미리보기 팝오버 — PM 비의존 순수 DOM 컨트롤러.
 *
 * document.body 에 position: fixed 요소를 붙여(에디터 overflow 클리핑 회피)
 * 마커 위(공간 부족 시 아래)에 띄운다. 데스크탑 hover 는 버튼 없는 표시용
 * (withJumpButton:false → pointer-events:none), 모바일 탭은 "이동" 버튼 포함.
 * 모바일 표시 중에는 바깥 pointerdown / scroll 시 자동으로 닫는다.
 */
export interface FootnotePreviewShowOptions {
	/** 모바일: "이동" 버튼을 렌더하고 인터랙티브하게 만든다. */
	withJumpButton: boolean;
	/** 설명을 찾지 못한 안내 상태(버튼 숨김). */
	missing?: boolean;
	/** 이동 버튼 클릭 시 호출(클릭 시 팝오버는 먼저 닫힌다). */
	onJump?: () => void;
}

export class FootnotePreview {
	private el: HTMLElement | null = null;
	private dismissHandler: ((ev: Event) => void) | null = null;

	show(
		anchorEl: HTMLElement,
		text: string,
		opts: FootnotePreviewShowOptions
	): void {
		this.hide();

		const el = document.createElement('div');
		el.className = 'tomboy-fn-preview';
		if (opts.missing) el.classList.add('tomboy-fn-preview-missing');
		if (!opts.withJumpButton) el.classList.add('tomboy-fn-preview-static');

		const body = document.createElement('div');
		body.className = 'tomboy-fn-preview-text';
		body.textContent = text;
		el.appendChild(body);

		if (opts.withJumpButton && !opts.missing) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'tomboy-fn-preview-jump';
			btn.textContent = '이동';
			btn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const jump = opts.onJump;
				this.hide();
				jump?.();
			});
			el.appendChild(btn);
		}

		document.body.appendChild(el);
		this.el = el;
		this.position(anchorEl);

		// 스크롤하면(데스크탑 hover·모바일 공통) 고정 위치 팝오버가 엉뚱한
		// 자리에 남으므로 닫는다. 바깥 탭 닫힘은 버튼이 있는 모바일에만 건다.
		// 현재 mousedown 이벤트 루프를 건너뛰도록 0ms 지연 후 등록(즉시 닫힘 방지).
		const handler = (ev: Event) => {
			if (ev.target instanceof Node && el.contains(ev.target)) return;
			this.hide();
		};
		this.dismissHandler = handler;
		window.setTimeout(() => {
			if (this.dismissHandler !== handler) return;
			window.addEventListener('scroll', handler, true);
			if (opts.withJumpButton) {
				document.addEventListener('pointerdown', handler, true);
			}
		}, 0);
	}

	hide(): void {
		if (this.dismissHandler) {
			document.removeEventListener('pointerdown', this.dismissHandler, true);
			window.removeEventListener('scroll', this.dismissHandler, true);
			this.dismissHandler = null;
		}
		if (this.el) {
			this.el.remove();
			this.el = null;
		}
	}

	/** 마커 기준 위쪽 배치(공간 부족 시 아래), 화면 밖으로 나가지 않게 보정. */
	private position(anchorEl: HTMLElement): void {
		const el = this.el;
		if (!el) return;
		const rect = anchorEl.getBoundingClientRect();
		const margin = 8;
		const elRect = el.getBoundingClientRect();
		let top = rect.top - elRect.height - margin;
		if (top < margin) top = rect.bottom + margin;
		let left = rect.left;
		const maxLeft = window.innerWidth - elRect.width - margin;
		if (left > maxLeft) left = Math.max(margin, maxLeft);
		el.style.top = `${Math.round(top)}px`;
		el.style.left = `${Math.round(left)}px`;
	}
}
