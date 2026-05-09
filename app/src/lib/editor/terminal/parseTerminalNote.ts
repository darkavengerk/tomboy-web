import type { JSONContent } from '@tiptap/core';

export interface TerminalNoteSpec {
	target: string;
	host: string;
	port?: number;
	user?: string;
	bridge?: string;
	/**
	 * Histories keyed by bucket. Key `''` is the non-tmux bucket; keys of the
	 * form `tmux:<window_id>` (e.g. `tmux:@1`) are per-tmux-window buckets.
	 */
	histories: Map<string, string[]>;
	/**
	 * Flat aggregate across all buckets, most-recent-first, deduplicated.
	 * Provided for callers that don't care about per-window separation.
	 */
	history: string[];
	/**
	 * Commands to send to the PTY (as `text + '\r'`) immediately after the WS
	 * reaches `'open'` status for the first time per view lifetime. Empty array
	 * when no `connect:` section is present or the section has no items.
	 */
	connect: string[];
	/**
	 * Pinned commands keyed by bucket. Key `''` is the non-tmux bucket; keys of
	 * the form `tmux:<window_id>` (e.g. `tmux:@1`) are per-tmux-window buckets.
	 * Pinned items always render above history in the panel.
	 */
	pinneds: Map<string, string[]>;
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;
export const HISTORY_HEADER_RE = /^history:(?:tmux:([A-Za-z0-9@$:_-]+):)?$/;
/** Matches exactly `connect:` — no tmux variants allowed. */
export const CONNECT_HEADER_RE = /^connect:$/;
export const PINNED_HEADER_RE = /^pinned:(?:tmux:([A-Za-z0-9@$:_-]+):)?$/;

export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;

	const bodyBlocks = blocks.slice(1);

	const meta: JSONContent[] = [];
	let i = 0;

	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	while (i < bodyBlocks.length) {
		const b = bodyBlocks[i];
		const t = paragraphText(b);
		if (t === null) break;
		if (t === '') {
			i++;
			continue;
		}
		const trimmed = t.trim();
		if (HISTORY_HEADER_RE.test(trimmed)) break;
		if (CONNECT_HEADER_RE.test(trimmed)) break;
		if (PINNED_HEADER_RE.test(trimmed)) break;
		if (meta.length >= 2) return null;
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

	const histories = new Map<string, string[]>();
	const pinneds = new Map<string, string[]>();
	let connect: string[] | null = null;

	while (i < bodyBlocks.length) {
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
		if (i >= bodyBlocks.length) break;

		const headerText = paragraphText(bodyBlocks[i]);
		if (headerText === null) return null;
		const trimmedHeader = headerText.trim();

		if (CONNECT_HEADER_RE.test(trimmedHeader)) {
			// connect: section — exactly one allowed
			if (connect !== null) return null;
			i++;
			while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
			let items: string[] = [];
			if (i < bodyBlocks.length && bodyBlocks[i].type === 'bulletList') {
				items = extractHistoryItems(bodyBlocks[i]);
				i++;
			} else if (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === null) {
				return null;
			}
			connect = items;
			continue;
		}

		const pm = PINNED_HEADER_RE.exec(trimmedHeader);
		if (pm) {
			const key = pm[1] ? `tmux:${pm[1]}` : '';
			i++;
			while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
			let items: string[] = [];
			if (i < bodyBlocks.length && bodyBlocks[i].type === 'bulletList') {
				items = extractHistoryItems(bodyBlocks[i]);
				i++;
			} else if (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === null) {
				return null;
			}
			if (pinneds.has(key)) return null;
			pinneds.set(key, items);
			continue;
		}

		const m = HISTORY_HEADER_RE.exec(trimmedHeader);
		if (!m) return null;
		const key = m[1] ? `tmux:${m[1]}` : '';
		i++;

		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

		let items: string[] = [];
		if (i < bodyBlocks.length && bodyBlocks[i].type === 'bulletList') {
			items = extractHistoryItems(bodyBlocks[i]);
			i++;
		} else if (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === null) {
			return null;
		}
		if (histories.has(key)) return null;
		histories.set(key, items);
	}

	const history = flattenHistories(histories);

	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge,
		histories,
		history,
		connect: connect ?? [],
		pinneds
	};
}

function flattenHistories(histories: Map<string, string[]>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const keys = Array.from(histories.keys()).sort((a, b) => {
		if (a === '') return -1;
		if (b === '') return 1;
		return a.localeCompare(b);
	});
	for (const k of keys) {
		for (const item of histories.get(k) ?? []) {
			if (seen.has(item)) continue;
			seen.add(item);
			out.push(item);
		}
	}
	return out;
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
	}
	return out;
}
