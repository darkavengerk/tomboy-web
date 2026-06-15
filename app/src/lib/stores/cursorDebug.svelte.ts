// Debug toggles for the mobile cursor / scroll behaviour.
//
// On the mobile note route (/note/[id], cursor-visibility "window" mode) several
// independent actors move the viewport while editing. When they disagree the
// caret can jump to the top of the screen while typing, or the page can slide
// down on selection. This store exposes each actor as its own on/off flag so the
// combination can be bisected by hand from 설정 → 디버그 — without a rebuild.
//
// Defaults reproduce the current production behaviour (everything ON). The flags
// are read live at each actor's call site, so most take effect immediately;
// editor-init wiring (handleScrollToSelection) re-reads on the next caret move.
// Persisted to localStorage so a reload keeps the chosen combination.
//
// DESKTOP (cursor-visibility "container" mode) deliberately ignores these — the
// call sites gate on cursorVisibilityMode === "window". A desktop NoteWindow's
// overflow scroller does not honour scroll-padding, so its JS nudge must always
// run; flipping these flags must not break it.

export type CursorDebugFlag =
	| "jsCursorNudge"
	| "pmScrollDefer"
	| "scrollPadding"
	| "keyboardInset"
	| "whitespaceTapFocus";

export type CursorDebugFlags = Record<CursorDebugFlag, boolean>;

const STORAGE_KEY = "tomboy:cursor-debug";

const DEFAULTS: CursorDebugFlags = {
	jsCursorNudge: true,
	pmScrollDefer: true,
	scrollPadding: true,
	keyboardInset: true,
	whitespaceTapFocus: true,
};

function load(): CursorDebugFlags {
	if (typeof localStorage === "undefined") return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		const parsed = JSON.parse(raw) as Partial<CursorDebugFlags>;
		// Spread over DEFAULTS so an older payload missing a newer flag still
		// gets that flag's default rather than `undefined`.
		return { ...DEFAULTS, ...parsed };
	} catch {
		return { ...DEFAULTS };
	}
}

/** Live, reactive flag set. Read `cursorDebug.<flag>` at the call site. */
export const cursorDebug = $state<CursorDebugFlags>(load());

function persist(): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cursorDebug }));
	} catch {
		// Best-effort: ignore quota / private-mode write failures.
	}
}

export function setCursorDebug(flag: CursorDebugFlag, value: boolean): void {
	cursorDebug[flag] = value;
	persist();
}

export function resetCursorDebug(): void {
	for (const key of Object.keys(DEFAULTS) as CursorDebugFlag[]) {
		cursorDebug[key] = DEFAULTS[key];
	}
	persist();
}
