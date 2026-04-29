import { createEmptyNote, formatTomboyDate, type NoteData } from './note.js';

import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';

const PREFIX = 'system:notebook:';
const TEMPLATE = 'system:template';
const CACHE_KEY = 'notebooksCache';

/** Extract the notebook name from a note's tags, or null if none. */
export function getNotebook(note: NoteData): string | null {
	const t = note.tags.find((x) => x.startsWith(PREFIX));
	return t ? t.slice(PREFIX.length) : null;
}

/** List all unique notebook names from all notes (including templates), sorted. */
export async function listNotebooks(): Promise<string[]> {
	const all = await noteStore.getAllNotesIncludingTemplates();
	const set = new Set<string>();
	for (const n of all) {
		for (const t of n.tags) {
			if (t.startsWith(PREFIX)) set.add(t.slice(PREFIX.length));
		}
	}
	return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 캐시된 노트북 목록을 즉시 반환한다. 없으면 계산 후 저장.
 * 자주 바뀌지 않으므로 매번 전체 노트를 훑는 대신 이 캐시를 사용한다.
 */
export async function getCachedNotebooks(): Promise<string[]> {
	const cached = await getSetting<string[]>(CACHE_KEY);
	if (cached) return cached;
	const fresh = await listNotebooks();
	await setSetting(CACHE_KEY, fresh);
	return fresh;
}

/** 노트북 목록 캐시를 다시 계산해서 저장한다. */
export async function refreshNotebooksCache(): Promise<string[]> {
	const fresh = await listNotebooks();
	await setSetting(CACHE_KEY, fresh);
	return fresh;
}

/** Create a notebook (idempotent — no-op if already exists). */
export async function createNotebook(name: string): Promise<void> {
	const clean = name.trim();
	if (!clean || clean.includes(':')) throw new Error('올바르지 않은 노트북 이름입니다.');
	const existing = await listNotebooks();
	if (existing.includes(clean)) return;

	const n = createEmptyNote(generateGuid());
	n.title = clean;
	n.tags = [TEMPLATE, PREFIX + clean];
	const now = formatTomboyDate(new Date());
	n.createDate = now;
	n.changeDate = now;
	n.metadataChangeDate = now;
	await noteStore.putNote(n);
	notifyNoteSaved(n.guid);
	await refreshNotebooksCache();
}

/** Assign a notebook to a note (replaces any existing notebook tag). */
export async function assignNotebook(guid: string, name: string | null): Promise<void> {
	const note = await noteStore.getNote(guid);
	if (!note) return;
	note.tags = note.tags.filter((t) => !t.startsWith(PREFIX));
	if (name) note.tags.push(PREFIX + name.trim());
	const now = formatTomboyDate(new Date());
	note.changeDate = now;
	note.metadataChangeDate = now;
	await noteStore.putNote(note);
	notifyNoteSaved(guid);
	invalidateCache();
	await refreshNotebooksCache();
}

/**
 * 노트 배열을 노트북 이름으로 필터링한다.
 * - null: 전체 반환
 * - '': 노트북 없는 노트만 반환
 * - 'xxx': 해당 노트북에 속한 노트만 반환
 */
export function filterByNotebook(notes: NoteData[], name: string | null): NoteData[] {
	if (name === null) return notes;
	if (name === '') return notes.filter((n) => !n.tags.some((t) => t.startsWith(PREFIX)));
	return notes.filter((n) => n.tags.includes(PREFIX + name));
}

/** Delete a notebook: removes template note + strips tag from member notes. */
export async function deleteNotebook(name: string): Promise<void> {
	const all = await noteStore.getAllNotesIncludingTemplates();
	const now = formatTomboyDate(new Date());
	for (const n of all) {
		const isTemplate = n.tags.includes(TEMPLATE) && n.tags.includes(PREFIX + name);
		if (isTemplate) {
			await noteStore.deleteNote(n.guid);
			notifyNoteSaved(n.guid);
			continue;
		}
		if (n.tags.includes(PREFIX + name)) {
			n.tags = n.tags.filter((t) => t !== PREFIX + name);
			n.changeDate = now;
			n.metadataChangeDate = now;
			await noteStore.putNote(n);
			notifyNoteSaved(n.guid);
		}
	}
	invalidateCache();
	await refreshNotebooksCache();
}
