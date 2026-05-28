/**
 * Pure state machine for "double-tap a bare modifier (Ctrl / Alt / Shift)
 * to toggle the matching sticky chip" shortcut. Mirrors `stickyMods.ts`'s
 * caller contract — no DOM / xterm dependency, caller drives the machine
 * with raw `KeyboardEvent` data and a wall-clock timestamp.
 *
 * The double-tap is detected as a CLEAN keydown → keyup → keydown of the
 * same modifier within `DOUBLE_TAP_WINDOW_MS`, where "clean" means:
 *   - no other key (modifier or otherwise) was pressed between the two
 *     taps;
 *   - no other modifier was held at the keyup moment.
 *
 * So `Ctrl+L` followed by an isolated `Ctrl, Ctrl` still works, but
 * `Ctrl, L, Ctrl` (without releasing Ctrl cleanly first) does not — the
 * `L` cancels the pending state.
 *
 * `KeyboardEvent.repeat` keydowns are ignored so holding a modifier down
 * does not register repeated taps.
 */

export type ModKey = 'ctrl' | 'alt' | 'shift';

export const DOUBLE_TAP_WINDOW_MS = 400;

export interface DoubleTapState {
	/** Mod whose clean keyup we just observed, awaiting a second keydown. */
	primingMod: ModKey | null;
	/** Wall-clock ms at which priming happened. */
	primingTime: number;
	/** Mod whose keydown we just observed, awaiting its clean keyup. */
	pendingMod: ModKey | null;
}

export const INITIAL_DOUBLE_TAP_STATE: DoubleTapState = {
	primingMod: null,
	primingTime: 0,
	pendingMod: null
};

export function modKeyFromEventKey(key: string): ModKey | null {
	if (key === 'Control') return 'ctrl';
	if (key === 'Alt') return 'alt';
	if (key === 'Shift') return 'shift';
	return null;
}

interface ModifierEventFlags {
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

function otherModHeld(flags: ModifierEventFlags, excluded: ModKey): boolean {
	if (excluded !== 'ctrl' && flags.ctrlKey) return true;
	if (excluded !== 'alt' && flags.altKey) return true;
	if (excluded !== 'shift' && flags.shiftKey) return true;
	return false;
}

export interface KeydownDecision {
	state: DoubleTapState;
	/** Non-null → caller should toggle this sticky mod and preventDefault. */
	toggle: ModKey | null;
}

/** Handle a bare modifier keydown. */
export function onModKeydown(
	state: DoubleTapState,
	mod: ModKey,
	repeat: boolean,
	now: number
): KeydownDecision {
	if (repeat) return { state, toggle: null };
	if (
		state.primingMod === mod &&
		now - state.primingTime < DOUBLE_TAP_WINDOW_MS
	) {
		return { state: INITIAL_DOUBLE_TAP_STATE, toggle: mod };
	}
	return {
		state: { primingMod: null, primingTime: 0, pendingMod: mod },
		toggle: null
	};
}

/** Handle a bare modifier keyup. */
export function onModKeyup(
	state: DoubleTapState,
	mod: ModKey,
	flags: ModifierEventFlags,
	now: number
): DoubleTapState {
	if (state.pendingMod !== mod || otherModHeld(flags, mod)) {
		return INITIAL_DOUBLE_TAP_STATE;
	}
	return { primingMod: mod, primingTime: now, pendingMod: null };
}

/** Any non-modifier keydown invalidates pending + priming. */
export function onNonModKeydown(state: DoubleTapState): DoubleTapState {
	if (state.primingMod === null && state.pendingMod === null) return state;
	return INITIAL_DOUBLE_TAP_STATE;
}
