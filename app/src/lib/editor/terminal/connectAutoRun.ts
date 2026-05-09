/**
 * Sends each line from `lines` to `send` as `line + '\r'`, with `delayMs`
 * milliseconds between calls. Empty / whitespace-only lines are skipped.
 * If `send` throws synchronously on a line, the error is swallowed and the
 * script continues with the next line.
 *
 * Used by TerminalView to auto-execute connect: commands once per WS-open
 * transition.
 */
export async function runConnectScript(
	lines: string[],
	send: (text: string) => void,
	delayMs = 50
): Promise<void> {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') continue;
		try {
			send(line + '\r');
		} catch {
			// continue — don't abort the whole script for one bad line
		}
		if (i < lines.length - 1 && delayMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}
