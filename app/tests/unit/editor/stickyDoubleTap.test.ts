import { describe, it, expect } from 'vitest';
import {
	DOUBLE_TAP_WINDOW_MS,
	INITIAL_DOUBLE_TAP_STATE,
	modKeyFromEventKey,
	onModKeydown,
	onModKeyup,
	onNonModKeydown
} from '$lib/editor/terminal/stickyDoubleTap.js';

const FLAGS_NONE = { ctrlKey: false, altKey: false, shiftKey: false };

describe('modKeyFromEventKey', () => {
	it('maps Control/Alt/Shift', () => {
		expect(modKeyFromEventKey('Control')).toBe('ctrl');
		expect(modKeyFromEventKey('Alt')).toBe('alt');
		expect(modKeyFromEventKey('Shift')).toBe('shift');
	});

	it('returns null for non-modifiers', () => {
		expect(modKeyFromEventKey('a')).toBeNull();
		expect(modKeyFromEventKey('Enter')).toBeNull();
		expect(modKeyFromEventKey('Meta')).toBeNull();
	});
});

describe('double-tap detection — happy path', () => {
	it('Ctrl, Ctrl within window → toggle ctrl', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		// first tap
		let r = onModKeydown(s, 'ctrl', false, 0);
		expect(r.toggle).toBeNull();
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 50);
		expect(s.primingMod).toBe('ctrl');
		// second tap within window
		r = onModKeydown(s, 'ctrl', false, 200);
		expect(r.toggle).toBe('ctrl');
		expect(r.state).toEqual(INITIAL_DOUBLE_TAP_STATE);
	});

	it('Alt, Alt within window → toggle alt', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'alt', false, 0);
		s = r.state;
		s = onModKeyup(s, 'alt', FLAGS_NONE, 20);
		r = onModKeydown(s, 'alt', false, 100);
		expect(r.toggle).toBe('alt');
	});

	it('Shift, Shift within window → toggle shift', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'shift', false, 0);
		s = r.state;
		s = onModKeyup(s, 'shift', FLAGS_NONE, 20);
		r = onModKeydown(s, 'shift', false, 100);
		expect(r.toggle).toBe('shift');
	});
});

describe('double-tap detection — negatives', () => {
	it('second tap outside window → no toggle, first-tap reset', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 50);
		// well past the window
		r = onModKeydown(s, 'ctrl', false, 50 + DOUBLE_TAP_WINDOW_MS + 10);
		expect(r.toggle).toBeNull();
		expect(r.state.pendingMod).toBe('ctrl');
		expect(r.state.primingMod).toBeNull();
	});

	it('different modifier on second tap → no toggle', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 50);
		r = onModKeydown(s, 'shift', false, 100);
		expect(r.toggle).toBeNull();
	});

	it('repeated keydown (auto-repeat) does not register tap', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		// 10× auto-repeat while held
		for (let i = 0; i < 10; i++) {
			r = onModKeydown(s, 'ctrl', true, 10 + i * 5);
			expect(r.toggle).toBeNull();
			s = r.state;
		}
		// then a clean release + re-press → should be first tap of fresh sequence,
		// not a double tap (because no keyup happened yet to prime)
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 100);
		r = onModKeydown(s, 'ctrl', false, 150);
		expect(r.toggle).toBe('ctrl');
	});

	it('non-modifier keydown between taps cancels priming', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 50);
		expect(s.primingMod).toBe('ctrl');
		// user presses some other key (no ctrl held)
		s = onNonModKeydown(s);
		expect(s).toEqual(INITIAL_DOUBLE_TAP_STATE);
		// now ctrl keydown → first tap, not toggle
		r = onModKeydown(s, 'ctrl', false, 100);
		expect(r.toggle).toBeNull();
	});

	it('Ctrl+L combo does not prime Ctrl double-tap', () => {
		// 1) Ctrl down
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		expect(s.pendingMod).toBe('ctrl');
		// 2) L down (with ctrl held)
		s = onNonModKeydown(s);
		expect(s.pendingMod).toBeNull();
		// 3) Ctrl up (after combo)
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 60);
		// pendingMod was cleared in step 2 → keyup must NOT prime
		expect(s.primingMod).toBeNull();
		// 4) Ctrl tap (would have been "second tap") → first tap
		r = onModKeydown(s, 'ctrl', false, 80);
		expect(r.toggle).toBeNull();
	});

	it('keyup while another modifier held does not prime', () => {
		let s = INITIAL_DOUBLE_TAP_STATE;
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		// keyup Ctrl but Shift is still held
		s = onModKeyup(s, 'ctrl', { ctrlKey: false, altKey: false, shiftKey: true }, 50);
		expect(s.primingMod).toBeNull();
	});
});

describe('toggle-off via second double-tap', () => {
	it('two consecutive double-taps both produce toggle events', () => {
		// caller is responsible for actually toggling sticky state — here
		// we just verify the machine emits toggle on each clean double-tap.
		let s = INITIAL_DOUBLE_TAP_STATE;
		// First double-tap
		let r = onModKeydown(s, 'ctrl', false, 0);
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 30);
		r = onModKeydown(s, 'ctrl', false, 100);
		expect(r.toggle).toBe('ctrl');
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 150);
		// Second double-tap
		r = onModKeydown(s, 'ctrl', false, 200);
		s = r.state;
		s = onModKeyup(s, 'ctrl', FLAGS_NONE, 230);
		r = onModKeydown(s, 'ctrl', false, 280);
		expect(r.toggle).toBe('ctrl');
	});
});
