import { describe, it, expect } from 'vitest';
import { RM_SLOT_LABELS, matchSlotLabel } from '$lib/remarkable/slots.js';

describe('slots', () => {
	it('exposes exactly the 5 known slot ids', () => {
		const ids = RM_SLOT_LABELS.map((s) => s.slot).sort();
		expect(ids).toEqual(['batteryempty', 'poweroff', 'rebooting', 'starting', 'suspended']);
	});

	it('matchSlotLabel maps Korean labels', () => {
		expect(matchSlotLabel('절전 중')).toBe('suspended');
		expect(matchSlotLabel('부팅 중')).toBe('starting');
		expect(matchSlotLabel('전원 꺼짐')).toBe('poweroff');
		expect(matchSlotLabel('재부팅 중')).toBe('rebooting');
		expect(matchSlotLabel('배터리 없음')).toBe('batteryempty');
	});

	it('matchSlotLabel tolerates a trailing colon', () => {
		expect(matchSlotLabel('절전 중:')).toBe('suspended');
		expect(matchSlotLabel('부팅 중 :')).toBe('starting');
	});

	it('matchSlotLabel returns null for unknown labels', () => {
		expect(matchSlotLabel('아무거나')).toBeNull();
		expect(matchSlotLabel('')).toBeNull();
	});
});
