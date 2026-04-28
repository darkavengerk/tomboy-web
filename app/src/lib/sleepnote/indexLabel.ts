/**
 * Slip-note category label lookup.
 *
 * The slip-box index note (INDEX_NOTE_GUID) lists every chain HEAD as a
 * bullet-list item. Each list item is shaped like
 *
 *     "<category text> <link:internal>HEAD title</link:internal>"
 *
 * The text BEFORE the link is the chain's category label (e.g. "과학" /
 * "노트"). For any slip note in a chain, the label is the same as its
 * chain's HEAD label — found by walking the note's `이전` links back to the
 * HEAD, then looking up the HEAD title in the index.
 *
 * Used to drive the "subtitle" placeholder shown on a slip note's empty
 * second line (see `TomboySubtitlePlaceholder`).
 */

import type { JSONContent } from '@tiptap/core';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { getNote, findNoteByTitle } from '$lib/core/noteManager.js';
import { INDEX_NOTE_GUID, validateSlipNoteFormat } from './validator.js';

/**
 * Walk every list item under every bullet/ordered list in the index and
 * return a `headTitle → labelText` map. Nested lists are walked too — a
 * sub-item is a separate entry whose label is its own paragraph's text
 * (not a path back to ancestors), matching how the user types entries.
 *
 * Multiple list items pointing at the same head title: first wins. The
 * label is the concatenated plain text BEFORE the first internal link in
 * the item's first paragraph, trimmed and with a trailing colon stripped
 * (so users can write either "과학" or "과학:" and get the same display).
 */
export function extractIndexLabelMap(indexXml: string): Map<string, string> {
	const doc = deserializeContent(indexXml);
	const map = new Map<string, string>();
	for (const block of doc.content ?? []) {
		walkListLike(block, map);
	}
	return map;
}

function walkListLike(node: JSONContent, map: Map<string, string>): void {
	if (node.type === 'bulletList' || node.type === 'orderedList') {
		for (const li of node.content ?? []) {
			if (li.type !== 'listItem') continue;
			processListItem(li, map);
		}
		return;
	}
	// Recurse into other block types only when they might contain lists.
	for (const child of node.content ?? []) {
		walkListLike(child, map);
	}
}

function processListItem(li: JSONContent, map: Map<string, string>): void {
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph') {
			const entry = extractLabelAndTarget(child);
			if (entry) {
				const key = entry.target.trim();
				if (key && !map.has(key)) map.set(key, entry.label);
			}
			break; // only the first paragraph of the item names the chain HEAD
		}
	}
	// Nested lists describe their own chains.
	for (const child of li.content ?? []) {
		if (child.type === 'bulletList' || child.type === 'orderedList') {
			walkListLike(child, map);
		}
	}
}

function extractLabelAndTarget(
	paragraph: JSONContent
): { label: string; target: string } | null {
	let label = '';
	for (const inl of paragraph.content ?? []) {
		if (inl.type !== 'text') continue;
		const linkMark = (inl.marks ?? []).find((m) => m.type === 'tomboyInternalLink');
		if (linkMark) {
			const target = (linkMark.attrs?.target ?? '').toString();
			if (!target.trim()) return null;
			return { label: cleanLabel(label), target };
		}
		label += inl.text ?? '';
	}
	return null;
}

function cleanLabel(raw: string): string {
	const trimmed = raw.trim();
	// Common pattern: users write "과학:" or "과학 -" before the link.
	// Strip a single trailing colon / dash / hyphen and any whitespace
	// around it so the placeholder reads cleanly.
	return trimmed.replace(/[\s:\-—–]+$/u, '').trim();
}

/**
 * Walk this slip note's `이전` chain backward until we hit a HEAD (no prev
 * link), then return that HEAD's trimmed title. Returns null if the note
 * isn't found, the format is broken, or a cycle is hit.
 */
export async function findChainHeadTitle(guid: string): Promise<string | null> {
	const visited = new Set<string>();
	let cur = await getNote(guid);
	while (cur) {
		if (visited.has(cur.guid)) return null;
		visited.add(cur.guid);

		const r = validateSlipNoteFormat(cur);
		const prev = r.prev;
		if (!prev || prev.kind !== 'link' || !prev.target) {
			return cur.title.trim();
		}
		const next = await findNoteByTitle(prev.target.trim());
		if (!next || next.deleted) return null;
		cur = next;
	}
	return null;
}

/**
 * End-to-end label lookup: walks the chain back to its HEAD, then reads
 * the index note to find the HEAD's category label. Returns null when the
 * note isn't a chain member, the index is missing, or the HEAD isn't
 * listed in the index.
 */
export async function getSlipNoteLabel(guid: string): Promise<string | null> {
	const headTitle = await findChainHeadTitle(guid);
	if (!headTitle) return null;
	const indexNote = await getNote(INDEX_NOTE_GUID);
	if (!indexNote) return null;
	const map = extractIndexLabelMap(indexNote.xmlContent);
	const label = map.get(headTitle);
	return label && label.length > 0 ? label : null;
}
