/** Pure helpers for OSC 133 shell-integration capture. No xterm import here. */

export type Osc133Kind = 'A' | 'B' | 'C' | 'D';

export interface Osc133Event {
	kind: Osc133Kind;
	/** Exit code, only set for kind 'D' when the payload supplied one. */
	exitCode?: number;
	/**
	 * Command text supplied by the shell (kind 'C' only, optional). When
	 * present, callers should prefer this over buffer scraping — it is
	 * exact and not subject to tmux redraw timing issues.
	 *
	 * Encoded as hex in the wire format: `OSC 133 ; C ; <hex> ST`.
	 */
	commandText?: string;
}

/**
 * Parse the body of an OSC 133 sequence (i.e. the part after `]133;`).
 *
 * Recognised payloads:
 * - `A`, `B`, `C`, `D` — standard markers
 * - `D;0`, `D;130` — D with exit code
 * - `C;<hex>` — extended C with the command text hex-encoded (our extension)
 *
 * Anything else returns null.
 */
export function parseOsc133Payload(payload: string): Osc133Event | null {
	if (!payload) return null;
	const parts = payload.split(';');
	const head = parts[0];
	if (head !== 'A' && head !== 'B' && head !== 'C' && head !== 'D') return null;
	if (head === 'D' && parts.length > 1) {
		const code = Number(parts[1]);
		if (Number.isInteger(code)) return { kind: 'D', exitCode: code };
		return { kind: 'D' };
	}
	if (head === 'C' && parts.length > 1) {
		const decoded = decodeHex(parts[1]);
		if (decoded !== null) return { kind: 'C', commandText: decoded };
		return { kind: 'C' };
	}
	return { kind: head };
}

/**
 * Decode an even-length string of `[0-9a-fA-F]` pairs into a UTF-8 string.
 * Returns null on malformed input.
 */
function decodeHex(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0) return null;
	if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
	}
	try {
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch {
		return null;
	}
}

export interface CommandExtractionInput {
	promptRow: number;
	promptCol: number;
	cursorRow: number;
	cursorCol: number;
	/** Returns the visible text of `row` (no trailing spaces stripped). */
	getLine: (row: number) => string;
}

/**
 * Extract the command text between (promptRow, promptCol) and (cursorRow,
 * cursorCol). Walks line-by-line, concatenating without inserting newlines
 * (visual lines that wrap belong to the same logical line).
 */
export function extractCommand(input: CommandExtractionInput): string {
	const { promptRow, promptCol, cursorRow, cursorCol, getLine } = input;
	if (cursorRow < promptRow) return '';
	if (cursorRow === promptRow) {
		const line = getLine(promptRow);
		return line.substring(promptCol, cursorCol);
	}
	let out = getLine(promptRow).substring(promptCol).replace(/\s+$/, '');
	for (let r = promptRow + 1; r < cursorRow; r++) {
		out += getLine(r).replace(/\s+$/, '');
	}
	out += getLine(cursorRow).substring(0, cursorCol);
	return out;
}

/**
 * Returns true if this command should be recorded.
 *
 * Rules (in order):
 *  1. starts with whitespace → reject (HISTCONTROL=ignorespace)
 *  2. empty after trim → reject
 *  3. first whitespace-split token is in blocklist → reject
 */
export function shouldRecordCommand(text: string, blocklist: string[]): boolean {
	if (text === '' || /^\s/.test(text)) return false;
	const trimmed = text.trim();
	if (trimmed === '') return false;
	const firstToken = trimmed.split(/\s+/, 1)[0];
	const blockset = new Set(blocklist);
	if (blockset.has(firstToken)) return false;
	return true;
}

/** Stateful tracker — TerminalView keeps one of these per session. */
export class Osc133State {
	private promptRow: number | null = null;
	private promptCol: number | null = null;
	private detected = false;

	get hasDetected(): boolean { return this.detected; }

	onPromptStart(): void {
		this.detected = true;
	}

	onCommandStart(row: number, col: number): void {
		this.detected = true;
		this.promptRow = row;
		this.promptCol = col;
	}

	consumeCommandOnExecute(
		cursorRow: number,
		cursorCol: number,
		getLine: (row: number) => string
	): string | null {
		if (this.promptRow === null || this.promptCol === null) {
			// ;C without a prior ;B — likely the user pressed Enter on a
			// shell that emitted ;A and ;C but skipped ;B (rare). Fall
			// back to the cursor row's start.
			const line = getLine(cursorRow);
			const text = line.substring(0, cursorCol);
			this.promptRow = null;
			this.promptCol = null;
			return text;
		}
		const text = extractCommand({
			promptRow: this.promptRow,
			promptCol: this.promptCol,
			cursorRow,
			cursorCol,
			getLine
		});
		this.promptRow = null;
		this.promptCol = null;
		return text;
	}
}
