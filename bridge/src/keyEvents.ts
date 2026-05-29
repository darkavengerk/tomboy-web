/**
 * 폰에 주입 가능한 키의 화이트리스트. 와이어로 들어오는 건 정수 keycode뿐이고,
 * 원격 명령은 검증된 정수만 고정 템플릿에 보간하므로 셸 인젝션이 불가능하다.
 * 키를 추가하려면 여기 한 줄만 늘리면 된다 (예: 26:'POWER').
 */
export const KEY_WHITELIST: Record<number, string> = {
	24: 'VOLUME_UP',
	25: 'VOLUME_DOWN'
};

/** 정수이면서 화이트리스트에 있는 keycode일 때만 true. */
export function isAllowedKeyCode(code: unknown): code is number {
	return typeof code === 'number' && Number.isInteger(code) && code in KEY_WHITELIST;
}

/**
 * 원격에서 실행할 명령 문자열. 화이트리스트에 없는 code는 즉시 throw한다.
 * 정수만 보간하므로 셸 메타문자가 끼어들 여지가 없다.
 * Termux 앱 uid엔 INJECT_EVENTS 권한이 없어 `su -c` 경유가 필수.
 */
export function buildKeyCommand(code: number): string {
	if (!isAllowedKeyCode(code)) throw new Error(`keycode ${code} not in whitelist`);
	return `su -c 'input keyevent ${code}'`;
}
