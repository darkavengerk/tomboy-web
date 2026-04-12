/**
 * Sync manager — orchestrates bidirectional sync between IndexedDB and Dropbox.
 *
 * Implements the Tomboy revision-based sync protocol:
 *   - Server stores notes in /{rev/100}/{rev}/{guid}.note
 *   - Root manifest.xml tracks all notes and their latest revision
 *   - Each sync increments the server revision number
 *   - Conflict resolution: last-write-wins based on changeDate
 */

import { parseNoteFromFile, serializeNote } from '$lib/core/noteArchiver.js';
import { parseTomboyDate } from '$lib/core/note.js';
import type { NoteData } from '$lib/core/note.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { getManifest, saveManifest, clearManifest } from './manifest.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import { refreshNotebooksCache } from '$lib/core/notebooks.js';
import {
	downloadServerManifest,
	downloadNoteAtRevision,
	commitRevision,
	initServerManifest,
	isAuthenticated,
	type TomboyServerManifest
} from './dropboxClient.js';

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error' | 'offline';

export interface SyncResult {
	status: 'success' | 'error';
	uploaded: number;
	downloaded: number;
	deleted: number;
	errors: string[];
}

// ─── Plan types ───────────────────────────────────────────────────────────────

export interface SyncPlanItem { guid: string; title?: string; }

export interface SyncPlan {
	serverRev: number;
	serverId: string;
	serverWasWiped: boolean;
	toDownload: Array<SyncPlanItem & { rev: number; reason: 'new' | 'updated' | 'conflict-remote-wins' }>;
	toUpload: Array<SyncPlanItem & { reason: 'new' | 'updated' }>;
	toDeleteRemote: SyncPlanItem[];
	toDeleteLocal: SyncPlanItem[];
	conflicts: Array<SyncPlanItem & { localDate: string; remoteDate: string; suggested: 'local' | 'remote' }>;
	/** Kept internally for applyPlan */
	_serverManifest: TomboyServerManifest | null;
}

export interface PlanSelection {
	download: Set<string>;
	upload: Set<string>;
	deleteRemote: Set<string>;
	deleteLocal: Set<string>;
	conflictChoice: Map<string, 'local' | 'remote'>;
}

// ─── Status listeners ─────────────────────────────────────────────────────────

type SyncListener = (status: SyncStatus, message?: string) => void;
const listeners: SyncListener[] = [];
let currentStatus: SyncStatus = 'idle';

export function onSyncStatus(listener: SyncListener): () => void {
	listeners.push(listener);
	listener(currentStatus);
	return () => {
		const idx = listeners.indexOf(listener);
		if (idx >= 0) listeners.splice(idx, 1);
	};
}

function setStatus(status: SyncStatus, message?: string) {
	currentStatus = status;
	for (const l of listeners) l(status, message);
}

export function getSyncStatus(): SyncStatus {
	return currentStatus;
}

/** Prevent concurrent syncs */
let syncing = false;

/** Reset internal state (for testing) */
export function _resetForTest() {
	syncing = false;
	currentStatus = 'idle';
}

// ─── Plan computation ─────────────────────────────────────────────────────────

/**
 * Compute what would happen in a sync — pure read operation, no IDB writes.
 */
export async function computePlan(): Promise<SyncPlan> {
	const localManifest = await getManifest();
	const allLocal = await noteStore.getAllNotesIncludingDeleted();
	const localByGuid = new Map<string, NoteData>();
	for (const n of allLocal) localByGuid.set(n.guid, n);

	const serverManifest = await downloadServerManifest();

	// Fresh server — everything local needs uploading
	if (serverManifest === null) {
		const toUpload = allLocal
			.filter((n) => !n.deleted)
			.map((n) => ({ guid: n.guid, title: n.title, reason: 'new' as const }));
		return {
			serverRev: 0,
			serverId: '',
			serverWasWiped: false,
			toDownload: [],
			toUpload,
			toDeleteRemote: [],
			toDeleteLocal: [],
			conflicts: [],
			_serverManifest: null
		};
	}

	const serverWasWiped = !!(localManifest.serverId && localManifest.serverId !== serverManifest.serverId);

	const serverNoteMap = new Map<string, number>();
	for (const n of serverManifest.notes) serverNoteMap.set(n.guid, n.rev);

	const toDownload: SyncPlan['toDownload'] = [];
	const toUpload: SyncPlan['toUpload'] = [];
	const toDeleteRemote: SyncPlanItem[] = [];
	const toDeleteLocal: SyncPlanItem[] = [];
	const conflicts: SyncPlan['conflicts'] = [];
	const conflictGuids = new Set<string>();

	// Determine what to download / handle conflicts
	for (const { guid, rev } of serverManifest.notes) {
		const localKnownRev = localManifest.noteRevisions[guid] ?? -1;
		if (rev <= localKnownRev) continue;

		const local = localByGuid.get(guid);

		if (local?.deleted) continue; // will be deleted from server in upload step

		if (!local) {
			toDownload.push({ guid, rev, reason: 'new' });
		} else if (local.localDirty) {
			// Both sides changed — conflict
			const localDate = parseTomboyDate(local.changeDate);
			const remoteDate = new Date(0); // we don't know remote date without downloading
			const suggested = localDate >= remoteDate ? 'local' : 'remote';
			conflicts.push({
				guid,
				title: local.title,
				localDate: local.changeDate,
				remoteDate: '', // filled after download in applyPlan
				suggested
			});
			conflictGuids.add(guid);
		} else {
			toDownload.push({ guid, rev, reason: 'updated' });
		}
	}

	// Determine local deletes to propagate
	for (const guid of Object.keys(localManifest.noteRevisions)) {
		if (serverNoteMap.has(guid)) continue;
		const local = localByGuid.get(guid);
		if (!local) continue;
		if (!local.localDirty) {
			toDeleteLocal.push({ guid, title: local.title });
		}
	}

	// Determine uploads
	for (const [guid, local] of localByGuid) {
		if (local.deleted) {
			if (serverNoteMap.has(guid)) {
				toDeleteRemote.push({ guid, title: local.title });
			}
			continue;
		}
		if (!local.localDirty) continue;
		if (conflictGuids.has(guid)) continue; // handled above
		toUpload.push({
			guid,
			title: local.title,
			reason: serverNoteMap.has(guid) ? 'updated' : 'new'
		});
	}

	return {
		serverRev: serverManifest.revision,
		serverId: serverManifest.serverId,
		serverWasWiped,
		toDownload,
		toUpload,
		toDeleteRemote,
		toDeleteLocal,
		conflicts,
		_serverManifest: serverManifest
	};
}

function selectAll(plan: SyncPlan): PlanSelection {
	return {
		download: new Set(plan.toDownload.map((x) => x.guid)),
		upload: new Set(plan.toUpload.map((x) => x.guid)),
		deleteRemote: new Set(plan.toDeleteRemote.map((x) => x.guid)),
		deleteLocal: new Set(plan.toDeleteLocal.map((x) => x.guid)),
		// No explicit conflict choices — applyPlan falls back to date comparison
		conflictChoice: new Map()
	};
}

// ─── Apply plan ───────────────────────────────────────────────────────────────

export async function applyPlan(plan: SyncPlan, selection?: PlanSelection): Promise<SyncResult> {
	const sel = selection ?? selectAll(plan);
	const result: SyncResult = { status: 'success', uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

	let localManifest = await getManifest();
	const allLocal = await noteStore.getAllNotesIncludingDeleted();
	const localByGuid = new Map<string, NoteData>();
	for (const n of allLocal) localByGuid.set(n.guid, n);

	// If server was wiped, reset local manifest
	if (plan.serverWasWiped) {
		await clearManifest();
		localManifest = await getManifest();
	}
	if (plan.serverId) localManifest.serverId = plan.serverId;

	// Fresh server path
	if (plan._serverManifest === null) {
		const toUploadItems = plan.toUpload
			.filter((x) => sel.upload.has(x.guid))
			.map((x) => {
				const n = localByGuid.get(x.guid)!;
				return { guid: x.guid, content: serializeNote(n) };
			});

		if (toUploadItems.length > 0) {
			const newServerManifest = await initServerManifest(toUploadItems);
			for (const { guid } of toUploadItems) {
				const n = localByGuid.get(guid)!;
				n.localDirty = false;
				await noteStore.putNoteSynced(n);
				localManifest.noteRevisions[guid] = newServerManifest.revision;
				result.uploaded++;
			}
			localManifest.serverId = newServerManifest.serverId;
			localManifest.lastSyncRev = newServerManifest.revision;
		}
		localManifest.lastSyncDate = new Date().toISOString();
		await saveManifest(localManifest);
		invalidateCache();
		try { await refreshNotebooksCache(); } catch { /* non-fatal */ }
		return result;
	}

	const serverManifest = plan._serverManifest;
	const serverNoteMap = new Map<string, number>();
	for (const n of serverManifest.notes) serverNoteMap.set(n.guid, n.rev);

	const processedGuids = new Set<string>();

	// ── Download selected notes ──────────────────────────────────────────────
	const toDownloadSelected = plan.toDownload.filter((x) => sel.download.has(x.guid));
	let downloadIdx = 0;

	for (const { guid, rev } of toDownloadSelected) {
		downloadIdx++;
		setStatus('syncing', `다운로드 중... (${downloadIdx}/${toDownloadSelected.length})`);
		try {
			const content = await downloadNoteAtRevision(guid, rev);
			const remoteNote = parseNoteFromFile(content, `${guid}.note`);
			remoteNote.localDirty = false;
			remoteNote.deleted = false;
			await noteStore.putNoteSynced(remoteNote);
			localManifest.noteRevisions[guid] = rev;
			result.downloaded++;
			processedGuids.add(guid);
			if (result.downloaded % 20 === 0) {
				await saveManifest(localManifest);
			}
		} catch (err) {
			result.errors.push(`Error downloading ${guid}: ${err}`);
		}
	}

	// ── Handle conflicts ─────────────────────────────────────────────────────
	// Always download conflicting notes to get their content/date, then decide.
	for (const conflict of plan.conflicts) {
		const explicitChoice = sel.conflictChoice.get(conflict.guid);
		const rev = serverNoteMap.get(conflict.guid) ?? 0;

		try {
			const content = await downloadNoteAtRevision(conflict.guid, rev);
			const remoteNote = parseNoteFromFile(content, `${conflict.guid}.note`);
			const local = localByGuid.get(conflict.guid);

			let useRemote: boolean;
			if (explicitChoice === 'remote') {
				useRemote = true;
			} else if (explicitChoice === 'local') {
				useRemote = false;
			} else {
				// No explicit choice — fall back to date comparison (last-write-wins)
				const localDate = local ? parseTomboyDate(local.changeDate) : new Date(0);
				const remoteDate = parseTomboyDate(remoteNote.changeDate);
				useRemote = remoteDate > localDate;
			}

			if (useRemote) {
				remoteNote.localDirty = false;
				await noteStore.putNoteSynced(remoteNote);
				localManifest.noteRevisions[conflict.guid] = rev;
				result.downloaded++;
				processedGuids.add(conflict.guid);
			} else {
				// local wins — will be uploaded below
				sel.upload.add(conflict.guid);
			}
		} catch (err) {
			result.errors.push(`Error handling conflict ${conflict.guid}: ${err}`);
		}
	}

	// Save checkpoint after downloads
	await saveManifest(localManifest);

	// ── Delete locally (server-removed notes) ───────────────────────────────
	for (const item of plan.toDeleteLocal) {
		if (!sel.deleteLocal.has(item.guid)) continue;
		const local = localByGuid.get(item.guid);
		if (!local) continue;
		if (!local.localDirty) {
			await noteStore.purgeNote(item.guid);
			delete localManifest.noteRevisions[item.guid];
			result.deleted++;
		}
	}

	// ── Upload local changes ─────────────────────────────────────────────────
	const toUploadItems: Array<{ guid: string; content: string; note: NoteData }> = [];
	const toDeleteItems: string[] = [];

	for (const item of plan.toDeleteRemote) {
		if (!sel.deleteRemote.has(item.guid)) continue;
		if (serverNoteMap.has(item.guid)) toDeleteItems.push(item.guid);
		await noteStore.purgeNote(item.guid);
		delete localManifest.noteRevisions[item.guid];
		result.deleted++;
	}

	for (const item of plan.toUpload) {
		if (!sel.upload.has(item.guid)) continue;
		const local = localByGuid.get(item.guid);
		if (!local || processedGuids.has(item.guid)) continue;
		toUploadItems.push({ guid: item.guid, content: serializeNote(local), note: local });
	}

	// Also upload conflict-local-wins notes
	// (sel.upload may have been updated during conflict resolution above)
	for (const conflict of plan.conflicts) {
		if (processedGuids.has(conflict.guid)) continue; // remote won
		if (!sel.upload.has(conflict.guid)) continue;
		const local = localByGuid.get(conflict.guid);
		if (!local) continue;
		if (!toUploadItems.some((x) => x.guid === conflict.guid)) {
			toUploadItems.push({ guid: conflict.guid, content: serializeNote(local), note: local });
		}
	}

	// ── Commit ───────────────────────────────────────────────────────────────
	if (toUploadItems.length > 0 || toDeleteItems.length > 0) {
		const newRev = serverManifest.revision + 1;
		if (toUploadItems.length > 0) {
			setStatus('syncing', `업로드 중... (${toUploadItems.length}개)`);
		}
		await commitRevision(
			newRev,
			toUploadItems.map(({ guid, content }) => ({ guid, content })),
			toDeleteItems,
			serverManifest
		);
		for (const { guid, note } of toUploadItems) {
			note.localDirty = false;
			await noteStore.putNoteSynced(note);
			localManifest.noteRevisions[guid] = newRev;
			result.uploaded++;
		}
		localManifest.lastSyncRev = newRev;
	} else {
		localManifest.lastSyncRev = serverManifest.revision;
	}

	localManifest.lastSyncDate = new Date().toISOString();
	await saveManifest(localManifest);

	result.status = result.errors.length > 0 ? 'error' : 'success';
	if (result.status === 'success') {
		invalidateCache();
		try { await refreshNotebooksCache(); } catch { /* non-fatal */ }
	}

	return result;
}

// ─── Per-note revert (discard local changes) ─────────────────────────────────

export interface RevertResult {
	status: 'success' | 'error';
	message?: string;
}

/**
 * Discard local changes for a single note: download the server's current
 * version and overwrite the local copy, marking it clean. Used by the
 * "변경 취소" button in the sync preview — essentially "I didn't mean to
 * change this locally; bring back what's on the server".
 *
 * Fails if:
 *   - not authenticated
 *   - server manifest cannot be loaded
 *   - the guid isn't on the server (e.g. it's a new local-only note — there
 *     is nothing to revert to; the caller should offer "delete locally" instead)
 *   - the download / parse fails
 */
export async function revertNoteToServer(guid: string): Promise<RevertResult> {
	if (!isAuthenticated()) {
		return { status: 'error', message: 'Not authenticated' };
	}

	let serverManifest: TomboyServerManifest | null;
	try {
		serverManifest = await downloadServerManifest();
	} catch (err) {
		return { status: 'error', message: `서버 매니페스트를 불러올 수 없습니다: ${err}` };
	}
	if (!serverManifest) {
		return { status: 'error', message: '서버에 매니페스트가 없습니다' };
	}

	const serverEntry = serverManifest.notes.find((n) => n.guid === guid);
	if (!serverEntry) {
		return {
			status: 'error',
			message: '서버에 해당 노트가 없습니다 (아직 업로드된 적 없음)'
		};
	}

	let remoteNote: NoteData;
	try {
		const content = await downloadNoteAtRevision(guid, serverEntry.rev);
		remoteNote = parseNoteFromFile(content, `${guid}.note`);
	} catch (err) {
		return { status: 'error', message: String(err) };
	}

	remoteNote.guid = guid;
	remoteNote.localDirty = false;
	remoteNote.deleted = false;
	await noteStore.putNoteSynced(remoteNote);

	const localManifest = await getManifest();
	localManifest.noteRevisions[guid] = serverEntry.rev;
	await saveManifest(localManifest);

	invalidateCache();
	try { await refreshNotebooksCache(); } catch { /* non-fatal */ }

	return { status: 'success' };
}

// ─── Main sync ────────────────────────────────────────────────────────────────

/**
 * Run a full sync cycle.
 */
export async function sync(): Promise<SyncResult> {
	if (syncing) {
		return { status: 'success', uploaded: 0, downloaded: 0, deleted: 0, errors: ['Sync already in progress'] };
	}

	if (!navigator.onLine) {
		setStatus('offline');
		return { status: 'error', uploaded: 0, downloaded: 0, deleted: 0, errors: ['Offline'] };
	}

	if (!isAuthenticated()) {
		return { status: 'error', uploaded: 0, downloaded: 0, deleted: 0, errors: ['Not authenticated'] };
	}

	syncing = true;
	setStatus('syncing');

	try {
		const plan = await computePlan();
		const result = await applyPlan(plan);
		setStatus(result.status === 'success' ? 'success' : 'error');
		return result;
	} catch (err) {
		const result: SyncResult = {
			status: 'error',
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			errors: [String(err)]
		};
		setStatus('error', String(err));
		return result;
	} finally {
		syncing = false;
	}
}
