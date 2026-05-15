/**
 * tmux control-mode (`tmux -CC`) protocol parser + client.
 *
 * Wire format (line-based, every line terminated by CR+LF or LF):
 *
 *   %begin <unix-time> <number> <flags>      ┐ command response block
 *   <output line 1>                          │
 *   ...                                      │
 *   %end <unix-time> <number> <flags>        ┘  (or %error)
 *
 *   %output %<pane-id> <escaped-bytes>       async pane output
 *   %window-pane-changed @<win-id> %<pane-id>
 *   %session-window-changed $<sess-id> @<win-id>
 *   %layout-change @<win-id> <layout> <visible-layout> [<flags>]
 *   %client-detached <client-name>
 *   %exit [reason]
 *   %<other-tag> ...                         passed through as `notification`
 *
 * Escape decoding for `%output` payloads — tmux wraps bytes that are
 * control characters, non-ASCII, or '\\' itself as `\<3 octal digits>`.
 * Everything else passes through verbatim.
 *
 * The parser is pure (operates on Buffer chunks fed via `feed()`) and uses
 * an EventEmitter for callbacks. The client layer (`TmuxControlClient`)
 * wires this to a writable stream and exposes `command(text)` returning
 * a Promise of response lines.
 *
 * Note: tmux can emit `%begin..%end` blocks spontaneously (notably the
 * initial-state dump at attach). We resolve pending commands FIFO and
 * surface unmatched blocks via `spontaneous-block` event so the caller
 * can decide whether to ignore them.
 */

import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

type ParserEvents = {
	output: [paneId: string, bytes: Buffer];
	windowPaneChanged: [windowId: string, paneId: string];
	sessionWindowChanged: [sessionId: string, windowId: string];
	layoutChange: [windowId: string, layout: string, visible: string, flags: string];
	clientDetached: [clientName: string];
	exit: [reason: string];
	notification: [tag: string, rest: Buffer];
	spontaneousBlock: [lines: string[]];
	commandResponse: [ok: boolean, lines: string[]];
};

export class TmuxControlParser extends EventEmitter {
	private buf: Buffer = Buffer.alloc(0);
	private block:
		| { unixTime: string; cmdId: string; flags: string; lines: string[] }
		| null = null;
	/**
	 * Partial DCS sequence carried over from a previous `feed()` chunk —
	 * non-null when a `\eP` has been seen but neither a final byte (for a
	 * bare intro like `\eP1000p`) nor a terminator (`\e\`) has arrived yet.
	 */
	private pendingDcs: Buffer | null = null;
	/**
	 * `\eP1000p`-style bare DCS opens are only emitted ONCE at the very
	 * start of `tmux -CC` mode. Every subsequent `\eP` is a passthrough that
	 * MUST be terminated by `\e\` — without this flag we'd wrongly strip
	 * `\ePt` from `\ePtmux;...` (the `t` looks like a DCS final byte by its
	 * codepoint) and leave the passthrough body in the protocol stream.
	 */
	private seenIntro = false;

	emit<K extends keyof ParserEvents>(event: K, ...args: ParserEvents[K]): boolean;
	emit(event: string, ...args: unknown[]): boolean {
		return super.emit(event, ...args);
	}
	on<K extends keyof ParserEvents>(event: K, listener: (...args: ParserEvents[K]) => void): this;
	on(event: string, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	feed(chunk: Buffer): void {
		// tmux -CC wraps its control protocol in DCS:
		//   - the initial introducer `\eP1000p` is a bare DCS open with no
		//     terminator (it stays open until tmux exits)
		//   - inline `\ePtmux;<wrapped>\e\` passthroughs forward OSC bytes
		//     from inner shells (e.g. our shell-integration OSC 133) to the
		//     "outer terminal" — but in spectator mode we ARE the outer
		//     terminal, so they should be dropped
		// Both forms appear *inline* with `%begin` lines (no \r\n separator),
		// so they must be stripped BEFORE splitting on newlines. Otherwise
		// the next `%begin` is glued to a `\eP...` prefix, the parser sees a
		// first byte of `\e` and emits the whole line as `notification`, the
		// %begin is missed, and the command-response FIFO shifts by one —
		// hanging the next `await client.command(...)` forever.
		const sanitized = this.stripDcs(chunk);
		this.buf = this.buf.length === 0 ? sanitized : Buffer.concat([this.buf, sanitized]);
		while (true) {
			const nl = this.buf.indexOf(0x0a);
			if (nl < 0) break;
			let end = nl;
			if (end > 0 && this.buf[end - 1] === 0x0d) end--;
			const line = this.buf.subarray(0, end);
			this.buf = this.buf.subarray(nl + 1);
			this.processLine(line);
		}
	}

	/**
	 * Remove every complete DCS (`\eP...`) sequence from the chunk. Two
	 * forms:
	 *   1. Bare intro: `\eP <params> <intermediates> <final-byte>` where
	 *      params are 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E
	 *      (`\eP1000p` is params="1000", final='p'). No terminator — the
	 *      body follows the final byte.
	 *   2. Terminated: `\eP <body> \e\` — strip start through terminator.
	 *
	 * In a terminated DCS, the body may contain doubled `\e\e` (an escaped
	 * `\e`); we treat `\e\` (0x1b 0x5c) as the terminator regardless,
	 * because `\e\e` (0x1b 0x1b) doesn't match.
	 *
	 * Incomplete DCS at the end of the chunk is parked in `pendingDcs` and
	 * prepended to the next `feed()` call.
	 */
	private stripDcs(chunk: Buffer): Buffer {
		if (this.pendingDcs) {
			chunk = Buffer.concat([this.pendingDcs, chunk]);
			this.pendingDcs = null;
		}
		const parts: Buffer[] = [];
		let i = 0;
		while (i < chunk.length) {
			const esc = chunk.indexOf(0x1b, i);
			if (esc < 0) {
				parts.push(chunk.subarray(i));
				break;
			}
			// Need at least one byte after the ESC to classify.
			if (esc + 1 >= chunk.length) {
				parts.push(chunk.subarray(i, esc));
				this.pendingDcs = Buffer.from([0x1b]);
				return Buffer.concat(parts);
			}
			if (chunk[esc + 1] !== 0x50 /* 'P' */) {
				// Not a DCS — emit `\e` and continue past it. Any other
				// escape sequence (CSI, OSC, etc.) is data we don't interpret.
				parts.push(chunk.subarray(i, esc + 1));
				i = esc + 1;
				continue;
			}
			// `\eP` introducer at position `esc`. Flush bytes before it.
			if (esc > i) parts.push(chunk.subarray(i, esc));
			// Search for terminator `\e\` and (only if the bytes after `\eP`
			// look like a standard DCS intro — at least one param byte then
			// the final) for the bare-intro final byte. tmux's passthrough
			// form `\ePtmux;...\e\` starts with `t` (0x74) which is in the
			// final-byte range, so we explicitly require at least one byte
			// in the param range (0x30-0x3F) before declaring a final byte
			// — otherwise `\ePt` would be mis-stripped as `\eP <final=t>`.
			let term = -1;
			let bareFinal = -1;
			let sawParamByte = false;
			let introStillValid = true;
			for (let k = esc + 2; k + 1 < chunk.length; k++) {
				const c = chunk[k];
				if (c === 0x1b && chunk[k + 1] === 0x5c /* '\' */) {
					term = k;
					break;
				}
				// Doubled `\e\e` inside DCS body — skip the second escape so
				// we don't mis-detect it as the start of a terminator pair.
				if (c === 0x1b && chunk[k + 1] === 0x1b) {
					k++;
					introStillValid = false;
					continue;
				}
				if (introStillValid && bareFinal < 0) {
					if (c >= 0x30 && c <= 0x3f) {
						sawParamByte = true;
					} else if (c >= 0x20 && c <= 0x2f) {
						// intermediate — allowed but doesn't count as param
					} else if (c >= 0x40 && c <= 0x7e && sawParamByte) {
						bareFinal = k;
						introStillValid = false;
					} else {
						introStillValid = false;
					}
				}
			}
			if (term >= 0) {
				// Complete terminated DCS — skip through `\e\`.
				i = term + 2;
				this.seenIntro = true;
				continue;
			}
			if (!this.seenIntro && bareFinal >= 0) {
				// Bare DCS intro at the very start of the stream
				// (`\eP1000p`) — strip introducer only; body continues
				// inline (the rest of the chunk is the protocol body).
				i = bareFinal + 1;
				this.seenIntro = true;
				continue;
			}
			// Incomplete DCS (no terminator yet, and not a first-time bare
			// intro). Park from `\eP` onwards for the next `feed()` call.
			this.pendingDcs = chunk.subarray(esc);
			return Buffer.concat(parts);
		}
		return Buffer.concat(parts);
	}

	private processLine(line: Buffer): void {
		// Inside a %begin..%end block, every line is body until we hit %end/%error.
		// Body lines themselves can in principle start with `%` (think of a
		// command that lists notification tags), so we only check for the
		// terminator while inside a block.
		if (this.block) {
			if (startsWithAscii(line, '%end ') || line.equals(Buffer.from('%end'))) {
				this.finishBlock(true);
				return;
			}
			if (startsWithAscii(line, '%error ') || line.equals(Buffer.from('%error'))) {
				this.finishBlock(false);
				return;
			}
			this.block.lines.push(line.toString('utf8'));
			return;
		}

		if (line.length === 0 || line[0] !== 0x25 /* % */) {
			// Plain line outside any block — surface as raw notification with empty tag.
			if (line.length > 0) this.emit('notification', '', line);
			return;
		}

		const sp = line.indexOf(0x20);
		const tag = (sp < 0 ? line : line.subarray(0, sp)).toString('ascii');
		const rest = sp < 0 ? Buffer.alloc(0) : line.subarray(sp + 1);

		switch (tag) {
			case '%begin': {
				const parts = rest.toString('ascii').split(' ');
				this.block = {
					unixTime: parts[0] ?? '',
					cmdId: parts[1] ?? '',
					flags: parts[2] ?? '',
					lines: []
				};
				return;
			}
			case '%output': {
				const sp2 = rest.indexOf(0x20);
				if (sp2 < 0) {
					// %output with no payload (empty) — emit empty buffer.
					this.emit('output', rest.toString('ascii'), Buffer.alloc(0));
					return;
				}
				const paneId = rest.subarray(0, sp2).toString('ascii');
				const payload = rest.subarray(sp2 + 1);
				this.emit('output', paneId, decodeTmuxOctal(payload));
				return;
			}
			case '%window-pane-changed': {
				const parts = rest.toString('ascii').split(' ');
				if (parts.length >= 2) this.emit('windowPaneChanged', parts[0], parts[1]);
				return;
			}
			case '%session-window-changed': {
				const parts = rest.toString('ascii').split(' ');
				if (parts.length >= 2) this.emit('sessionWindowChanged', parts[0], parts[1]);
				return;
			}
			case '%layout-change': {
				const parts = rest.toString('ascii').split(' ');
				if (parts.length >= 2) {
					this.emit('layoutChange', parts[0], parts[1], parts[2] ?? '', parts[3] ?? '');
				}
				return;
			}
			case '%client-detached': {
				this.emit('clientDetached', rest.toString('ascii').trim());
				return;
			}
			case '%exit': {
				this.emit('exit', rest.toString('utf8').trim());
				return;
			}
			default: {
				this.emit('notification', tag, rest);
				return;
			}
		}
	}

	private finishBlock(ok: boolean): void {
		const lines = this.block?.lines ?? [];
		const flags = this.block?.flags ?? '';
		this.block = null;
		// tmux marks blocks emitted in response to a client (-CC) command
		// with `flags=1`; internal/spontaneous blocks (notably the initial
		// state dump emitted right after attach) have `flags=0`. Routing by
		// flags is load-bearing: if we treat the initial dump as a command
		// response, it consumes the head of our pending-command FIFO and
		// every subsequent command's response gets delivered to the wrong
		// promise — bootstrap's `display-message` then awaits a response
		// that has already been claimed by `refresh-client`, hanging forever.
		if (flags === '1') {
			this.emit('commandResponse', ok, lines);
		} else {
			this.emit('spontaneousBlock', lines);
		}
	}

	/** Test helper — true if we're mid-block (i.e. waiting for %end/%error). */
	get inBlock(): boolean {
		return this.block !== null;
	}
}

/**
 * Decode a tmux %output escaped payload to its raw bytes.
 *
 * tmux escapes every byte b where b < 0x20, b > 0x7e, or b == 0x5c ('\\')
 * as the 4-byte sequence `\xyz` (xyz being 3 octal digits of the value).
 * Other ASCII printable bytes pass through verbatim.
 */
export function decodeTmuxOctal(input: Buffer): Buffer {
	const out = Buffer.allocUnsafe(input.length);
	let w = 0;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === 0x5c && i + 3 < input.length) {
			const d0 = input[i + 1];
			const d1 = input[i + 2];
			const d2 = input[i + 3];
			if (isOctal(d0) && isOctal(d1) && isOctal(d2)) {
				out[w++] = ((d0 - 0x30) << 6) | ((d1 - 0x30) << 3) | (d2 - 0x30);
				i += 3;
				continue;
			}
		}
		out[w++] = c;
	}
	return out.subarray(0, w);
}

function isOctal(c: number): boolean {
	return c >= 0x30 && c <= 0x37;
}

function startsWithAscii(buf: Buffer, prefix: string): boolean {
	if (buf.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (buf[i] !== prefix.charCodeAt(i)) return false;
	}
	return true;
}

// ─── Client ────────────────────────────────────────────────────────────────

interface PendingCommand {
	resolve: (lines: string[]) => void;
	reject: (err: Error) => void;
}

/**
 * Higher-level wrapper: pairs the parser with a writable side so callers
 * can `await command('display -p ...')` and get response lines.
 *
 * Commands are processed strictly FIFO by tmux. The first
 * `commandResponse` after we send goes to the head of the queue. tmux's
 * initial-state dump on attach happens BEFORE any command is sent, so it
 * cannot be confused with a command response.
 */
export class TmuxControlClient extends TmuxControlParser {
	private writable: Writable;
	private pending: PendingCommand[] = [];
	private closed = false;

	constructor(writable: Writable) {
		super();
		this.writable = writable;
		super.on('commandResponse', (ok, lines) => {
			const head = this.pending.shift();
			if (!head) {
				this.emit('spontaneousBlock', lines);
				return;
			}
			if (ok) head.resolve(lines);
			else head.reject(new Error(lines.join('\n') || 'tmux command failed'));
		});
	}

	command(cmd: string): Promise<string[]> {
		if (this.closed) return Promise.reject(new Error('client closed'));
		return new Promise<string[]>((resolve, reject) => {
			this.pending.push({ resolve, reject });
			this.writable.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const err = new Error('client closed');
		for (const p of this.pending.splice(0)) p.reject(err);
	}
}
