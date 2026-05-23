/**
 * 터미널 벨 — 터미널이 BEL(\x07)을 보내면 짧은 합성 비프음 + (모바일) 진동.
 * xterm의 `onBell` 이벤트에 연결해서 쓴다. shell 모드 전용.
 */

/** 프로그램이 \x07를 연타해도 오디오가 스팸되지 않도록 하는 최소 간격. */
const BELL_THROTTLE_MS = 300;

/**
 * 순수 스로틀 판정: `lastAt`(직전 벨 시각, 벨이 없었으면 null)을 기준으로
 * `now` 시점의 벨을 울려야 하는지.
 */
export function shouldRing(lastAt: number | null, now: number): boolean {
	if (lastAt === null) return true;
	return now - lastAt >= BELL_THROTTLE_MS;
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	if (!audioCtx) audioCtx = new Ctor();
	return audioCtx;
}

/** ~150ms 사인파 비프음. 클릭음 방지용 attack/decay 엔벨로프. */
function playBeep(): void {
	const ctx = getAudioContext();
	if (!ctx) return;
	// 자동재생 정책상 suspended일 수 있음 — 사용자는 노트를 열고 타이핑하며
	// 이미 상호작용했으므로 resume()이 통과한다.
	void ctx.resume();
	const t0 = ctx.currentTime;
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = 880;
	gain.gain.setValueAtTime(0, t0);
	gain.gain.linearRampToValueAtTime(0.2, t0 + 0.01); // 10ms attack
	gain.gain.setValueAtTime(0.2, t0 + 0.09);
	gain.gain.linearRampToValueAtTime(0, t0 + 0.15); // 60ms release
	osc.connect(gain).connect(ctx.destination);
	osc.start(t0);
	osc.stop(t0 + 0.16);
}

/**
 * 벨 링어를 만든다. 반환된 함수를 `term.onBell`에 넘긴다. 내부에서
 * `shouldRing`으로 스로틀한다.
 */
export function createBellRinger(): () => void {
	let lastAt: number | null = null;
	return () => {
		const now = Date.now();
		if (!shouldRing(lastAt, now)) return;
		lastAt = now;
		playBeep();
		try {
			navigator.vibrate?.(200);
		} catch {
			/* 진동 미지원 — 데스크탑 등 */
		}
	};
}
