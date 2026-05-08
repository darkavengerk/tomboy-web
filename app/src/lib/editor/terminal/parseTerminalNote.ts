import type { JSONContent } from '@tiptap/core';

export interface TerminalNoteSpec {
	target: string;
	host: string;
	port?: number;
	user?: string;
	bridge?: string;
	/** Captured command history. Empty array when none. */
	history: string[];
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;
const HISTORY_HEADER = 'history:';

export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;

	const bodyBlocks = blocks.slice(1);

	// Walk the body building (a) the SSH/bridge metadata paragraphs and
	// (b) the optional history section. Any unexpected block fails the
	// whole match — same strictness as before.
	const meta: JSONContent[] = [];
	let i = 0;

	// Skip leading empty paragraphs (Tomboy round-trip artefact).
	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	// Collect non-empty paragraphs until we hit either the history header
	// or a non-paragraph block. We allow up to 2 metadata paragraphs.
	while (i < bodyBlocks.length) {
		const b = bodyBlocks[i];
		const t = paragraphText(b);
		if (t === null) break; // non-paragraph — could be the bulletList of a malformed note; handled below
		if (t === '') {
			// Empty paragraph between metadata and history is the optional separator.
			// Skip it.
			i++;
			continue;
		}
		if (t.trim() === HISTORY_HEADER) break; // history section starts here
		if (meta.length >= 2) return null; // a third meaningful metadata paragraph → fail
		meta.push(b);
		i++;
	}

	if (meta.length < 1) return null;

	const line1 = paragraphText(meta[0]);
	if (line1 === null) return null;
	const sshMatch = SSH_RE.exec(line1);
	if (!sshMatch) return null;

	let bridge: string | undefined;
	if (meta.length === 2) {
		const line2 = paragraphText(meta[1]);
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

	// Now `i` points at either end-of-body, the history-header paragraph,
	// or some other block. If end-of-body → no history. If history-header
	// paragraph → consume it and look for an immediately-following
	// bulletList. Anything else → not a terminal note.
	let history: string[] = [];

	// Skip trailing empty paragraphs that don't precede a history block.
	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	if (i < bodyBlocks.length) {
		const headerText = paragraphText(bodyBlocks[i]);
		if (headerText === null) return null; // bulletList without header → fail
		if (headerText.trim() !== HISTORY_HEADER) return null;
		i++;

		// Optional empty paragraph between header and list (defensive — TipTap
		// shouldn't insert one but the original note may have been hand-edited).
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

		if (i < bodyBlocks.length) {
			const listBlock = bodyBlocks[i];
			if (listBlock.type !== 'bulletList') return null;
			history = extractHistoryItems(listBlock);
			i++;
		}

		// Allow trailing empty paragraphs after the list.
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
		if (i < bodyBlocks.length) return null; // anything else after history → fail
	}

	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge,
		history
	};
}

function paragraphText(block: JSONContent): string | null {
	if (!block || block.type !== 'paragraph') return null;
	if (!block.content) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') {
			out += child.text ?? '';
		} else if (child.type === 'hardBreak') {
			return null;
		} else {
			return null;
		}
	}
	return out;
}

function extractHistoryItems(listBlock: JSONContent): string[] {
	const items: string[] = [];
	const children = Array.isArray(listBlock.content) ? listBlock.content : [];
	for (const li of children) {
		if (li.type !== 'listItem') continue;
		const text = listItemText(li).trim();
		if (text === '') continue;
		items.push(text);
	}
	return items;
}

function listItemText(item: JSONContent): string {
	if (!Array.isArray(item.content)) return '';
	let out = '';
	for (const child of item.content) {
		if (child.type === 'paragraph') {
			if (Array.isArray(child.content)) {
				for (const inline of child.content) {
					if (inline.type === 'text') out += inline.text ?? '';
				}
			}
		}
		// Nested bulletLists inside a listItem are ignored: we only take
		// the listItem's own paragraph text. This keeps history flat.
	}
	return out;
}
