import type { JSONContent } from '@tiptap/core';
import { getNote, putNote } from '$lib/storage/noteStore.js';
import { formatTomboyDate } from '$lib/core/note.js';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { parseTerminalNote } from './parseTerminalNote.js';

const HISTORY_HEADER = 'history:';
const HISTORY_CAP = 50;
const DEBOUNCE_MS = 500;

interface PendingState {
	queue: string[];
	timer: ReturnType<typeof setTimeout> | null;
	chain: Promise<void>;
}

const pending = new Map<string, PendingState>();

function getOrInitPending(guid: string): PendingState {
	let p = pending.get(guid);
	if (!p) {
		p = { queue: [], timer: null, chain: Promise.resolve() };
		pending.set(guid, p);
	}
	return p;
}

/**
 * Append a captured command to the terminal note's history. Debounced
 * 500ms per guid; coalesces multiple appends into a single read-modify-write.
 *
 * If the note is no longer a terminal note (parseTerminalNote returns null)
 * the queued command is silently dropped on flush.
 *
 * Commands that are empty after trim, or that start with whitespace
 * (HISTCONTROL=ignorespace convention) are rejected here as a defensive
 * second check — primary filtering is in oscCapture.
 */
export function appendCommandToTerminalHistory(guid: string, command: string): void {
	if (command === '' || /^\s/.test(command)) return;
	const trimmed = command.trim();
	if (trimmed === '') return;
	const p = getOrInitPending(guid);
	p.queue.push(trimmed);
	if (p.timer) clearTimeout(p.timer);
	p.timer = setTimeout(() => {
		void flushOne(guid);
	}, DEBOUNCE_MS);
}

/**
 * Flush the debounced queue NOW. Without arguments, flushes every queued
 * guid. With a guid, flushes only that one.
 */
export async function flushTerminalHistoryNow(guid?: string): Promise<void> {
	if (guid) {
		await flushOne(guid);
		return;
	}
	const guids = Array.from(pending.keys());
	await Promise.all(guids.map((g) => flushOne(g)));
}

async function flushOne(guid: string): Promise<void> {
	const p = pending.get(guid);
	if (!p) return;
	if (p.timer) {
		clearTimeout(p.timer);
		p.timer = null;
	}
	const batch = p.queue;
	p.queue = [];
	if (batch.length === 0) return;
	// Chain so concurrent appendCommandToTerminalHistory calls land in
	// order. We swallow per-batch errors to avoid stalling the chain.
	p.chain = p.chain.then(async () => {
		try {
			await applyBatch(guid, batch);
		} catch (err) {
			console.warn('[terminalHistory] flush failed', err);
		}
	});
	await p.chain;
}

async function applyBatch(guid: string, commands: string[]): Promise<void> {
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return; // not a terminal note (anymore) — drop

	const next = applyCommandsToDoc(doc, commands);
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
 * Remove the history item at `index`. Index is into the current list
 * (most-recent-first ordering). No-op if out of range.
 */
export async function removeCommandFromTerminalHistory(
	guid: string,
	index: number
): Promise<void> {
	// Flush any pending appends first so the index the caller saw is
	// consistent with what we mutate.
	await flushOne(guid);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	if (index < 0 || index >= spec.history.length) return;
	const next = removeItemFromDoc(doc, index);
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

export async function clearTerminalHistory(guid: string): Promise<void> {
	await flushOne(guid);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec || spec.history.length === 0) return;
	const next = clearHistoryFromDoc(doc);
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

interface SplitDoc {
	pre: JSONContent[]; // title + meta paragraphs (everything before history)
	historyItems: string[]; // current items
	hasHistorySection: boolean;
}

export function splitTerminalDoc(doc: JSONContent): SplitDoc {
	const out: SplitDoc = { pre: [], historyItems: [], hasHistorySection: false };
	if (!Array.isArray(doc.content)) return out;
	const blocks = doc.content;
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type === 'paragraph') {
			const t = paragraphTextSimple(b);
			if (t.trim() === HISTORY_HEADER) {
				out.hasHistorySection = true;
				i++;
				// Skip empty paragraphs immediately after the header.
				while (i < blocks.length && blocks[i].type === 'paragraph' && paragraphTextSimple(blocks[i]).trim() === '') {
					i++;
				}
				if (i < blocks.length && blocks[i].type === 'bulletList') {
					out.historyItems = extractListItems(blocks[i]);
					i++;
				}
				// Anything after the list is dropped — the parser would
				// have rejected it, but in writers we tolerate by ignoring.
				break;
			}
		}
		out.pre.push(b);
		i++;
	}
	return out;
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

function buildHistorySection(items: string[]): JSONContent[] {
	if (items.length === 0) return [];
	return [
		{ type: 'paragraph' }, // visual separator before header
		{ type: 'paragraph', content: [{ type: 'text', text: HISTORY_HEADER }] },
		{
			type: 'bulletList',
			content: items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		}
	];
}

export function applyCommandsToDoc(doc: JSONContent, commands: string[]): JSONContent {
	const split = splitTerminalDoc(doc);
	let items = split.historyItems.slice();
	for (const cmd of commands) {
		const trimmed = cmd.trim();
		if (trimmed === '') continue;
		// move-to-top dedup
		items = items.filter((x) => x !== trimmed);
		items.unshift(trimmed);
		if (items.length > HISTORY_CAP) items = items.slice(0, HISTORY_CAP);
	}
	return { type: 'doc', content: [...split.pre, ...buildHistorySection(items)] };
}

export function removeItemFromDoc(doc: JSONContent, index: number): JSONContent {
	const split = splitTerminalDoc(doc);
	if (index < 0 || index >= split.historyItems.length) return doc;
	const items = split.historyItems.slice();
	items.splice(index, 1);
	return { type: 'doc', content: [...split.pre, ...buildHistorySection(items)] };
}

export function clearHistoryFromDoc(doc: JSONContent): JSONContent {
	const split = splitTerminalDoc(doc);
	return { type: 'doc', content: split.pre };
}

/** Test-only reset of pending state. */
export function _resetForTest(): void {
	for (const p of pending.values()) {
		if (p.timer) clearTimeout(p.timer);
	}
	pending.clear();
}
