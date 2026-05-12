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

	emit<K extends keyof ParserEvents>(event: K, ...args: ParserEvents[K]): boolean;
	emit(event: string, ...args: unknown[]): boolean {
		return super.emit(event, ...args);
	}
	on<K extends keyof ParserEvents>(event: K, listener: (...args: ParserEvents[K]) => void): this;
	on(event: string, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	feed(chunk: Buffer): void {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
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
		this.block = null;
		// Distinction between "response to a command we sent" vs. "spontaneous"
		// belongs in the client layer (which tracks pending commands); the
		// parser just announces every terminated block.
		this.emit('commandResponse', ok, lines);
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
