/**
 * 음악추출 완료 알림음 — 추출이 끝나면(성공/실패) 짧은 합성 차임 + (모바일) 진동.
 * 추출은 오래 걸려 사용자가 다른 일을 하다 자리를 비우므로 끝났음을 소리로 알린다.
 * `terminalBell` 과 같은 WebAudio 합성 패턴 — 외부 음원 파일 없음.
 */

export type ChimeKind = 'success' | 'error';

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

/**
 * ⟳ 클릭 시점(사용자 제스처)에 호출해 오디오 컨텍스트를 미리 깨운다.
 * 추출이 끝나는 시점은 제스처에서 한참 뒤(수 분)라 그때 resume()이 막힐 수 있으므로,
 * 제스처가 살아있는 클릭 순간 unlock 해 둔다(iOS/자동재생 정책 회피).
 */
export function unlockExtractAudio(): void {
	void getAudioContext()?.resume();
}

/** 한 음을 부드러운 attack/release 엔벨로프로 재생(클릭음 방지). */
function tone(ctx: AudioContext, freq: number, start: number, dur: number, peak: number): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0, start);
	gain.gain.linearRampToValueAtTime(peak, start + 0.01); // 10ms attack
	gain.gain.setValueAtTime(peak, start + dur - 0.05);
	gain.gain.linearRampToValueAtTime(0, start + dur); // 50ms release
	osc.connect(gain).connect(ctx.destination);
	osc.start(start);
	osc.stop(start + dur + 0.02);
}

/**
 * 완료 차임. 성공 = 상행 2음(밝게), 실패 = 하행 2음(낮게) — 귀로 성패 구분.
 * 모바일이면 진동도 같이(성공 짧게, 실패 3번).
 */
export function playExtractChime(kind: ChimeKind): void {
	const ctx = getAudioContext();
	if (ctx) {
		void ctx.resume();
		const t0 = ctx.currentTime;
		const d = 0.14;
		if (kind === 'success') {
			tone(ctx, 880, t0, d, 0.18); // A5
			tone(ctx, 1318.5, t0 + d, d, 0.18); // E6 — 상행
		} else {
			tone(ctx, 440, t0, d, 0.18); // A4
			tone(ctx, 329.6, t0 + d, d, 0.18); // E4 — 하행
		}
	}
	try {
		navigator.vibrate?.(kind === 'success' ? 120 : [80, 60, 80]);
	} catch {
		/* 진동 미지원 — 데스크탑 등 */
	}
}
