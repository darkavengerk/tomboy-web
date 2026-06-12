/**
 * 미니 플레이어 드래그 시작 가드.
 *
 * 알약/그립 컨테이너에 onpointerdown→setPointerCapture 를 걸면 자식 버튼(✕/▶)에서
 * 시작한 포인터 시퀀스도 컨테이너가 캡처한다. 포인터 캡처 중에는 pointerup 과
 * 호환 click 이 캡처 요소로 재타게팅되므로 버튼의 onclick 이 발화하지 않는다
 * (✕ 눌러도 패널이 안 닫히는 버그). 인터랙티브 요소에서 시작한 pointerdown 은
 * 드래그(=캡처)를 시작하지 말아야 한다.
 */
export function dragStartAllowed(target: EventTarget | null): boolean {
	if (!(target instanceof Node)) return true;
	const el = target instanceof Element ? target : target.parentElement;
	if (!el) return true;
	return el.closest('button, input, a, select, textarea') === null;
}
