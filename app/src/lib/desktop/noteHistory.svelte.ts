import type { NoteData } from '$lib/core/note.js';
import {
	searchNoteRevisions,
	downloadServerManifest,
	downloadRevisionManifest,
	type NoteRevisionRef
} from '$lib/sync/dropboxClient.js';
import { fetchNoteAtRevision } from '$lib/sync/adminClient.js';
import { getNoteEditorContent } from '$lib/core/noteManager.js';
import { tiptapToPlainText } from '$lib/editor/copyFormatted.js';

/** How many manifests to pull per fallback-scan batch. */
const FALLBACK_BATCH = 30;

export function formatVersionLabel(ref: NoteRevisionRef): string {
	if (!ref.date) return `rev ${ref.rev}`;
	const d = new Date(ref.date);
	const label = isNaN(+d) ? ref.date : d.toLocaleString('ko-KR');
	return `rev ${ref.rev} · ${label}`;
}

export function noteToPlainText(note: NoteData): string {
	return tiptapToPlainText(getNoteEditorContent(note));
}

export interface NoteHistory {
	readonly versions: NoteRevisionRef[];
	readonly loading: boolean;
	readonly error: string;
	readonly usedFallback: boolean;
	readonly hasMore: boolean;
	load(): Promise<void>;
	loadMore(): Promise<void>;
	fetchBody(rev: number): Promise<NoteData | null>;
}

export function createNoteHistory(guid: string): NoteHistory {
	let versions = $state<NoteRevisionRef[]>([]);
	let loading = $state(false);
	let error = $state('');
	let usedFallback = $state(false);
	let hasMore = $state(false);

	const bodies = new Map<number, NoteData | null>();
	let currentRev = 0;
	let scanCursor = 0; // next rev to scan downward in fallback mode

	function upsert(refs: NoteRevisionRef[]) {
		const byRev = new Map(versions.map((v) => [v.rev, v]));
		for (const r of refs) if (!byRev.has(r.rev)) byRev.set(r.rev, r);
		versions = [...byRev.values()].sort((a, b) => b.rev - a.rev);
	}

	async function scanMore(count: number) {
		const seenNoteRev = new Set(versions.map((v) => v.rev));
		const start = scanCursor;
		const end = Math.max(1, start - count + 1);
		const refs: NoteRevisionRef[] = [];
		for (let rev = start; rev >= end; rev--) {
			const m = await downloadRevisionManifest(rev);
			if (!m) continue;
			const entry = m.notes.find((n) => n.guid === guid);
			if (!entry || seenNoteRev.has(entry.rev)) continue;
			seenNoteRev.add(entry.rev);
			refs.push({ rev: entry.rev, date: '' });
		}
		upsert(refs);
		scanCursor = end - 1;
		hasMore = scanCursor >= 1;
	}

	async function loadFallback() {
		usedFallback = true;
		versions = [];
		scanCursor = currentRev;
		await scanMore(FALLBACK_BATCH);
	}

	return {
		get versions() { return versions; },
		get loading() { return loading; },
		get error() { return error; },
		get usedFallback() { return usedFallback; },
		get hasMore() { return hasMore; },

		async load() {
			loading = true;
			error = '';
			versions = [];
			usedFallback = false;
			hasMore = false;
			try {
				const root = await downloadServerManifest();
				currentRev = root?.notes.find((n) => n.guid === guid)?.rev ?? root?.revision ?? 0;
				let refs: NoteRevisionRef[] = [];
				try {
					refs = await searchNoteRevisions(guid);
				} catch {
					refs = [];
				}
				if (refs.length === 0) {
					await loadFallback();
				} else {
					upsert(refs);
					if (currentRev > 0 && !versions.some((v) => v.rev === currentRev)) {
						upsert([{ rev: currentRev, date: '' }]);
					}
				}
			} catch (e) {
				error = String(e);
			} finally {
				loading = false;
			}
		},

		async loadMore() {
			if (!usedFallback || !hasMore) return;
			loading = true;
			try {
				await scanMore(FALLBACK_BATCH);
			} catch (e) {
				error = String(e);
			} finally {
				loading = false;
			}
		},

		async fetchBody(rev: number) {
			if (bodies.has(rev)) return bodies.get(rev) ?? null;
			const note = await fetchNoteAtRevision(guid, rev);
			bodies.set(rev, note);
			return note;
		}
	};
}
