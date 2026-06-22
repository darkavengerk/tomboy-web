/**
 * 새 배포 감지 알림음 — `updated.current` 가 true 로 바뀌어 "새 버전이 있습니다"
 * 안내 토스트를 띄울 때 같이 울린다. 사용자가 다른 탭/일을 하다 자리를 비웠어도
 * 소리로 새 버전 도착을 알린다. `terminalBell`/`extractChime` 과 같은 WebAudio
 * 합성 패턴 — 외부 음원 파일 없음.
 *
 * 자동재생 정책: 이 함수는 사용자 제스처가 아니라 버전 폴링 시점에 호출되므로
 * AudioContext 가 suspended 일 수 있다. 하지만 사용자가 이미 앱을 한참 쓰다
 * 보면 클릭/타이핑으로 상호작용한 뒤라 resume() 이 대부분 통과한다. 막혀도
 * 토스트는 그대로 뜨므로 안내 자체는 유지된다(소리만 빠짐).
 */

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

/** 한 음을 부드러운 attack/release 엔벨로프로 재생(클릭음 방지). */
function tone(ctx: AudioContext, freq: number, start: number, dur: number, peak: number): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0, start);
	gain.gain.linearRampToValueAtTime(peak, start + 0.01); // 10ms attack
	gain.gain.setValueAtTime(peak, start + dur - 0.06);
	gain.gain.linearRampToValueAtTime(0, start + dur); // 60ms release
	osc.connect(gain).connect(ctx.destination);
	osc.start(start);
	osc.stop(start + dur + 0.02);
}

/**
 * 새 버전 도착 차임 — 밝게 상행하는 3음(도-미-솔 비슷). 알림임을 분명히 하되
 * 짧고 부드럽게. 모바일이면 진동도 같이.
 */
export function playUpdateChime(): void {
	const ctx = getAudioContext();
	if (ctx) {
		void ctx.resume();
		const t0 = ctx.currentTime;
		const d = 0.16;
		tone(ctx, 659.3, t0, d, 0.16); // E5
		tone(ctx, 880, t0 + d, d, 0.16); // A5
		tone(ctx, 1174.7, t0 + 2 * d, d * 1.4, 0.16); // D6 — 상행
	}
	try {
		navigator.vibrate?.([90, 50, 90]);
	} catch {
		/* 진동 미지원 — 데스크탑 등 */
	}
}
