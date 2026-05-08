import type { JSONContent } from '@tiptap/core';
import { getNote, putNote } from '$lib/storage/noteStore.js';
import { formatTomboyDate } from '$lib/core/note.js';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { parseTerminalNote, HISTORY_HEADER_RE } from './parseTerminalNote.js';

const HISTORY_CAP = 50;
const DEBOUNCE_MS = 500;

interface PendingState {
	queue: string[];
	timer: ReturnType<typeof setTimeout> | null;
	chain: Promise<void>;
}

const pending = new Map<string, PendingState>();

function pendingKey(guid: string, windowKey: string): string {
	return `${guid} ${windowKey}`;
}

function getOrInitPending(guid: string, windowKey: string): PendingState {
	const k = pendingKey(guid, windowKey);
	let p = pending.get(k);
	if (!p) {
		p = { queue: [], timer: null, chain: Promise.resolve() };
		pending.set(k, p);
	}
	return p;
}

function normalizeKey(windowKey?: string): string {
	return windowKey ?? '';
}

export function appendCommandToTerminalHistory(
	guid: string,
	command: string,
	windowKey?: string
): void {
	if (command === '' || /^\s/.test(command)) return;
	const trimmed = command.trim();
	if (trimmed === '') return;
	const key = normalizeKey(windowKey);
	const p = getOrInitPending(guid, key);
	p.queue.push(trimmed);
	if (p.timer) clearTimeout(p.timer);
	p.timer = setTimeout(() => {
		void flushOne(guid, key);
	}, DEBOUNCE_MS);
}

/**
 * Flush the debounced queue NOW. Without arguments, flushes every queued
 * guid. With a guid, flushes only that one (all window keys for that guid).
 */
export async function flushTerminalHistoryNow(guid?: string): Promise<void> {
	if (guid) {
		const matchPrefix = `${guid} `;
		const keys = Array.from(pending.keys()).filter((k) => k.startsWith(matchPrefix));
		await Promise.all(
			keys.map((k) => flushOne(guid, k.slice(matchPrefix.length)))
		);
		return;
	}
	const allKeys = Array.from(pending.keys());
	await Promise.all(
		allKeys.map((k) => {
			const idx = k.indexOf(' ');
			return flushOne(k.slice(0, idx), k.slice(idx + 1));
		})
	);
}

async function flushOne(guid: string, windowKey: string): Promise<void> {
	const k = pendingKey(guid, windowKey);
	const p = pending.get(k);
	if (!p) return;
	if (p.timer) {
		clearTimeout(p.timer);
		p.timer = null;
	}
	const batch = p.queue;
	p.queue = [];
	// Chain unconditionally so every flushOne call serialises against any
	// in-flight write. The empty-batch check moves inside so we still
	// await the chain even when there is nothing new to write.
	p.chain = p.chain.then(async () => {
		if (batch.length === 0) return;
		try {
			await applyBatch(guid, batch, windowKey);
		} catch (err) {
			console.warn('[terminalHistory] flush failed', err);
		}
	});
	await p.chain;
}

async function applyBatch(guid: string, commands: string[], windowKey: string): Promise<void> {
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return; // not a terminal note (anymore) — drop

	const next = applyCommandsToDoc(doc, commands, windowKey || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

/**
 * Remove the history item at `index` within the targeted bucket.
 * Index is into the bucket's list (most-recent-first ordering). No-op if out of range.
 */
export async function removeCommandFromTerminalHistory(
	guid: string,
	index: number,
	windowKey?: string
): Promise<void> {
	const key = normalizeKey(windowKey);
	// Flush any pending appends first so the index the caller saw is
	// consistent with what we mutate.
	await flushOne(guid, key);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	const items = spec.histories.get(key) ?? [];
	if (index < 0 || index >= items.length) return;
	const next = removeItemFromDoc(doc, index, key || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

export async function clearTerminalHistory(guid: string, windowKey?: string): Promise<void> {
	const key = normalizeKey(windowKey);
	await flushOne(guid, key);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	if (!spec.histories.has(key)) return;
	const next = clearHistoryFromDoc(doc, key || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

// ── Pure doc helpers (exported for tests) ──────────────────────────────

interface SplitDocByKey {
	pre: JSONContent[];
	histories: Map<string, string[]>;
}

export function splitTerminalDocByKey(doc: JSONContent): SplitDocByKey {
	const out: SplitDocByKey = { pre: [], histories: new Map() };
	if (!Array.isArray(doc.content)) return out;
	const blocks = doc.content;
	let i = 0;

	// pre = everything before the first history header (excluding trailing empty paragraphs)
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type === 'paragraph' && HISTORY_HEADER_RE.test(paragraphTextSimple(b).trim())) break;
		out.pre.push(b);
		i++;
	}
	// Trim trailing empty paragraphs from pre (visual separators before first history section)
	while (out.pre.length > 0) {
		const last = out.pre[out.pre.length - 1];
		if (last.type === 'paragraph' && paragraphTextSimple(last).trim() === '') {
			out.pre.pop();
		} else {
			break;
		}
	}

	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type !== 'paragraph') {
			i++;
			continue;
		}
		const t = paragraphTextSimple(b).trim();
		const m = HISTORY_HEADER_RE.exec(t);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1] ? `tmux:${m[1]}` : '';
		i++;
		while (i < blocks.length && blocks[i].type === 'paragraph' && paragraphTextSimple(blocks[i]).trim() === '') {
			i++;
		}
		let items: string[] = [];
		if (i < blocks.length && blocks[i].type === 'bulletList') {
			items = extractListItems(blocks[i]);
			i++;
		}
		out.histories.set(key, items);
	}
	return out;
}

interface SplitDoc {
	pre: JSONContent[]; // title + meta paragraphs (everything before history)
	historyItems: string[]; // current items (non-tmux bucket only)
	hasHistorySection: boolean;
}

/** Legacy single-section view — returns the non-tmux bucket only. Back-compat alias. */
export function splitTerminalDoc(doc: JSONContent): SplitDoc {
	const split = splitTerminalDocByKey(doc);
	return {
		pre: split.pre,
		historyItems: split.histories.get('') ?? [],
		hasHistorySection: split.histories.has('')
	};
}

function paragraphTextSimple(p: JSONContent): string {
	if (!Array.isArray(p.content)) return '';
	let out = '';
	for (const child of p.content) {
		if (child.type === 'text') out += child.text ?? '';
	}
	return out;
}

function extractListItems(list: JSONContent): string[] {
	const items: string[] = [];
	const children = Array.isArray(list.content) ? list.content : [];
	for (const li of children) {
		if (li.type !== 'listItem') continue;
		let text = '';
		if (Array.isArray(li.content)) {
			for (const child of li.content) {
				if (child.type === 'paragraph') text += paragraphTextSimple(child);
			}
		}
		const trimmed = text.trim();
		if (trimmed !== '') items.push(trimmed);
	}
	return items;
}

function buildSection(key: string, items: string[]): JSONContent[] {
	if (items.length === 0) return [];
	const header = key === '' ? 'history:' : `history:${key}:`;
	return [
		{ type: 'paragraph' }, // visual separator before header
		{ type: 'paragraph', content: [{ type: 'text', text: header }] },
		{
			type: 'bulletList',
			content: items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		}
	];
}

function buildAllSections(histories: Map<string, string[]>): JSONContent[] {
	const keys = Array.from(histories.keys()).sort((a, b) => {
		if (a === '') return -1;
		if (b === '') return 1;
		return a.localeCompare(b);
	});
	const out: JSONContent[] = [];
	for (const k of keys) {
		out.push(...buildSection(k, histories.get(k) ?? []));
	}
	return out;
}

export function applyCommandsToDoc(
	doc: JSONContent,
	commands: string[],
	windowKey?: string
): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	let items = (split.histories.get(key) ?? []).slice();
	for (const cmd of commands) {
		const trimmed = cmd.trim();
		if (trimmed === '') continue;
		// move-to-top dedup
		items = items.filter((x) => x !== trimmed);
		items.unshift(trimmed);
		if (items.length > HISTORY_CAP) items = items.slice(0, HISTORY_CAP);
	}
	const next = new Map(split.histories);
	if (items.length === 0) next.delete(key);
	else next.set(key, items);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

export function removeItemFromDoc(
	doc: JSONContent,
	index: number,
	windowKey?: string
): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	const items = (split.histories.get(key) ?? []).slice();
	if (index < 0 || index >= items.length) return doc;
	items.splice(index, 1);
	const next = new Map(split.histories);
	if (items.length === 0) next.delete(key);
	else next.set(key, items);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

export function clearHistoryFromDoc(doc: JSONContent, windowKey?: string): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	const next = new Map(split.histories);
	next.delete(key);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

/** Test-only reset of pending state. */
export function _resetForTest(): void {
	for (const p of pending.values()) {
		if (p.timer) clearTimeout(p.timer);
	}
	pending.clear();
}
