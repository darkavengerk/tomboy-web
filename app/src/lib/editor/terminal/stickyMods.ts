/**
 * Pure key→byte mapping for spectator-mode sticky modifier chips.
 * No DOM / xterm dependency — caller passes `event.key` (or a string's
 * first char) plus the armed sticky state and gets a terminal byte
 * sequence to send, or null if the combination is not supported.
 */

export interface StickyMods {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

const SPECIAL_KEY_BYTES: Record<string, string> = {
	Enter: '\r',
	Backspace: '\x7f',
	Escape: '\x1b',
	Tab: '\t'
};

function isLetter(key: string): boolean {
	return key.length === 1 && /[a-zA-Z]/.test(key);
}

function isPrintable(key: string): boolean {
	return key.length === 1;
}

function ctrlByteForLetter(letter: string): string {
	return String.fromCharCode(letter.toLowerCase().charCodeAt(0) & 0x1f);
}

function transformChar(key: string, sticky: StickyMods): string | null {
	const anyArmed = sticky.ctrl || sticky.alt || sticky.shift;
	if (!anyArmed) return null;

	if (isLetter(key)) {
		if (sticky.ctrl && sticky.alt) return '\x1b' + ctrlByteForLetter(key);
		if (sticky.ctrl) return ctrlByteForLetter(key);
		if (sticky.alt) return '\x1b' + key;
		if (sticky.shift) return key.toUpperCase();
		return null;
	}

	if (isPrintable(key)) {
		if (sticky.alt && !sticky.ctrl) return '\x1b' + key;
		if (sticky.shift && !sticky.ctrl && !sticky.alt) return key;
		return null;
	}

	const special = SPECIAL_KEY_BYTES[key];
	if (special !== undefined) {
		if (sticky.alt && !sticky.ctrl && !sticky.shift) return '\x1b' + special;
		return null;
	}

	return null;
}

/**
 * Compute the byte sequence to send for `event` when one or more
 * sticky modifiers are armed. Returns null when the combination is not
 * supported (caller should leave sticky armed and let the key fall
 * through to its default handling).
 *
 * Reads only `event.key`. Caller is responsible for merging any real
 * modifier state into `sticky` if desired — this function does not
 * consult `event.ctrlKey` / `event.altKey` / `event.shiftKey`.
 */
export function computeStickyKeySequence(
	event: KeyboardEvent,
	sticky: StickyMods
): string | null {
	return transformChar(event.key, sticky);
}

/**
 * Mobile-popup variant of `computeStickyKeySequence`. Applies the
 * armed modifier to the FIRST character of `text`; the remainder is
 * returned verbatim. Empty `text`, no armed mods, or an unsupported
 * first char → null (caller should send text as-is).
 */
export function applyStickyToText(
	text: string,
	sticky: StickyMods
): string | null {
	if (text.length === 0) return null;
	const first = text[0];
	const transformed = transformChar(first, sticky);
	if (transformed === null) return null;
	return transformed + text.slice(1);
}
