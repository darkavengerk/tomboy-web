import { describe, it, expect } from 'vitest';
import { isBridgeTitle } from '$lib/bridgeStatus/parseBridgeNote.js';

describe('isBridgeTitle', () => {
	it('브릿지:: 접두는 true', () => {
		expect(isBridgeTitle('브릿지::현황')).toBe(true);
		expect(isBridgeTitle('브릿지::')).toBe(true);
		expect(isBridgeTitle('브릿지:: 내 파이')).toBe(true);
	});
	it('선행 공백 허용', () => {
		expect(isBridgeTitle('  브릿지::x')).toBe(true);
	});
	it('다른 제목은 false', () => {
		expect(isBridgeTitle('음악추출::x')).toBe(false);
		expect(isBridgeTitle('브릿지 현황')).toBe(false);
		expect(isBridgeTitle('내 브릿지::x')).toBe(false);
		expect(isBridgeTitle('')).toBe(false);
	});
});
