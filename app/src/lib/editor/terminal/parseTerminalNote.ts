import type { JSONContent } from '@tiptap/core';

export interface TerminalNoteSpec {
	/** Raw target string, e.g. "ssh://user@host:22" or "ssh://localhost". */
	target: string;
	/** Parsed components of the target. */
	host: string;
	port?: number;
	user?: string;
	/** Optional explicit bridge URL (wss://...). When absent, fall back to app default. */
	bridge?: string;
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;

/**
 * Recognize a terminal-note from a TipTap doc. The body (everything after the
 * title paragraph) must consist of exactly 1 or 2 non-empty paragraphs:
 *   line1: ssh://[user@]host[:port]
 *   line2 (optional): bridge: wss://...
 *
 * Anything else — extra paragraphs, lists, marks, broken patterns — falls
 * back to a regular note.
 */
export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;

	// blocks[0] is the title paragraph; we don't constrain it.
	const bodyBlocks = blocks.slice(1);

	// Drop trailing empty paragraphs — TipTap sometimes leaves an empty one
	// at the end of a doc. We require the *meaningful* body to be 1 or 2.
	const trimmed: JSONContent[] = [];
	for (const b of bodyBlocks) {
		const text = paragraphText(b);
		if (text === null) return null; // non-paragraph block → not a terminal note
		if (text === '' && trimmed.length === 0) continue; // skip leading empty
		trimmed.push(b);
	}
	while (trimmed.length > 0 && paragraphText(trimmed[trimmed.length - 1]) === '') {
		trimmed.pop();
	}
	if (trimmed.length < 1 || trimmed.length > 2) return null;

	const line1 = paragraphText(trimmed[0]);
	if (line1 === null) return null;
	const sshMatch = SSH_RE.exec(line1);
	if (!sshMatch) return null;

	let bridge: string | undefined;
	if (trimmed.length === 2) {
		const line2 = paragraphText(trimmed[1]);
		if (line2 === null) return null;
		const bridgeMatch = BRIDGE_RE.exec(line2);
		if (!bridgeMatch) return null;
		bridge = bridgeMatch[1];
	}

	const user = sshMatch[1] || undefined;
	const host = sshMatch[2];
	const portRaw = sshMatch[3];
	const port = portRaw ? Number(portRaw) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge
	};
}

/**
 * Returns the plain text of a paragraph block, or null if `block` isn't a
 * paragraph. An empty paragraph yields `''`. Marks are ignored — we only
 * care about textual content for pattern matching.
 */
function paragraphText(block: JSONContent): string | null {
	if (!block || block.type !== 'paragraph') return null;
	if (!block.content) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') {
			out += child.text ?? '';
		} else if (child.type === 'hardBreak') {
			// A hardBreak inside the metadata line would split the URL — fail.
			return null;
		} else {
			// Any other inline node (image, etc.) → not a terminal note.
			return null;
		}
	}
	return out;
}
