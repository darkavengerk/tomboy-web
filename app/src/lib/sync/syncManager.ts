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

// ─── Progress types ──────────────────────────────────────────────────────────

export type SyncItemStatus = 'pending' | 'active' | 'done' | 'error' | 'retrying';

export interface SyncProgressItem {
	guid: string;
	title?: string;
	status: SyncItemStatus;
	error?: string;
	retryAttempt?: number;
	retryWaitSec?: number;
}

export interface SyncCompletedPhase {
	label: string;
	count: number;
	errors: number;
	items: SyncProgressItem[];
}

export interface SyncProgress {
	phase: 'download' | 'conflict' | 'delete-local' | 'upload' | 'commit' | 'done';
	phaseLabel: string;
	items: SyncProgressItem[];
	completedPhases: SyncCompletedPhase[];
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

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

export async function applyPlan(
	plan: SyncPlan,
	selection?: PlanSelection,
	onProgress?: SyncProgressCallback
): Promise<SyncResult> {
	const sel = selection ?? selectAll(plan);
	const result: SyncResult = { status: 'success', uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

	const completedPhases: SyncProgress['completedPhases'] = [];

	function emitProgress(
		phase: SyncProgress['phase'],
		phaseLabel: string,
		items: SyncProgressItem[]
	) {
		onProgress?.({
			phase,
			phaseLabel,
			items: items.map((i) => ({ ...i })),
			completedPhases: [...completedPhases]
		});
	}

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
				return { guid: x.guid, title: n.title, content: serializeNote(n) };
			});

		if (toUploadItems.length > 0) {
			const items: SyncProgressItem[] = toUploadItems.map((x) => ({
				guid: x.guid,
				title: x.title,
				status: 'pending' as SyncItemStatus
			}));
			emitProgress('upload', '업로드', items);
			setStatus('syncing', `업로드 중... (0/${toUploadItems.length})`);

			const newServerManifest = await initServerManifest(
				toUploadItems.map(({ guid, content }) => ({ guid, content })),
				{
					onUploadStart: (guid) => {
						const item = items.find((i) => i.guid === guid);
						if (item) item.status = 'active';
						emitProgress('upload', '업로드', items);
					},
					onUploadDone: (guid) => {
						const item = items.find((i) => i.guid === guid);
						if (item) item.status = 'done';
						const done = items.filter((i) => i.status === 'done').length;
						setStatus('syncing', `업로드 중... (${done}/${items.length})`);
						emitProgress('upload', '업로드', items);
					},
					onUploadRetry: (guid, attempt, waitMs) => {
						const item = items.find((i) => i.guid === guid);
						if (item) {
							item.status = 'retrying';
							item.retryAttempt = attempt;
							item.retryWaitSec = Math.ceil(waitMs / 1000);
						}
						emitProgress('upload', '업로드', items);
					},
					onUploadError: (guid, error) => {
						const item = items.find((i) => i.guid === guid);
						if (item) {
							item.status = 'error';
							item.error = String(error);
						}
						emitProgress('upload', '업로드', items);
					}
				}
			);

			for (const { guid } of toUploadItems) {
				const n = localByGuid.get(guid)!;
				n.localDirty = false;
				await noteStore.putNoteSynced(n);
				localManifest.noteRevisions[guid] = newServerManifest.revision;
				result.uploaded++;
			}
			localManifest.serverId = newServerManifest.serverId;
			localManifest.lastSyncRev = newServerManifest.revision;

			const doneCount = items.filter((i) => i.status === 'done').length;
			const errorCount = items.filter((i) => i.status === 'error').length;
			completedPhases.push({
				label: '업로드',
				count: doneCount,
				errors: errorCount,
				items: items.map((i) => ({ ...i }))
			});
		}
		localManifest.lastSyncDate = new Date().toISOString();
		await saveManifest(localManifest);
		invalidateCache();
		try {
			await refreshNotebooksCache();
		} catch {
			/* non-fatal */
		}
		setStatus('success');
		emitProgress('done', '완료', []);
		return result;
	}

	const serverManifest = plan._serverManifest;
	const serverNoteMap = new Map<string, number>();
	for (const n of serverManifest.notes) serverNoteMap.set(n.guid, n.rev);

	const processedGuids = new Set<string>();

	// ── Download selected notes (sequential) ────────────────────────────────
	const toDownloadSelected = plan.toDownload.filter((x) => sel.download.has(x.guid));
	if (toDownloadSelected.length > 0) {
		const items: SyncProgressItem[] = toDownloadSelected.map((x) => ({
			guid: x.guid,
			title: x.title,
			status: 'pending' as SyncItemStatus
		}));
		emitProgress('download', '다운로드', items);
		setStatus('syncing', `다운로드 중... (0/${toDownloadSelected.length})`);

		for (let i = 0; i < toDownloadSelected.length; i++) {
			const { guid, rev } = toDownloadSelected[i];
			items[i].status = 'active';
			emitProgress('download', '다운로드', items);

			try {
				const content = await downloadNoteAtRevision(guid, rev, (attempt, waitMs) => {
					items[i].status = 'retrying';
					items[i].retryAttempt = attempt;
					items[i].retryWaitSec = Math.ceil(waitMs / 1000);
					emitProgress('download', '다운로드', items);
				});
				const remoteNote = parseNoteFromFile(content, `${guid}.note`);
				remoteNote.localDirty = false;
				remoteNote.deleted = false;
				await noteStore.putNoteSynced(remoteNote);
				localManifest.noteRevisions[guid] = rev;
				result.downloaded++;
				processedGuids.add(guid);
				items[i].status = 'done';
			} catch (err) {
				items[i].status = 'error';
				items[i].error = String(err);
				result.errors.push(`다운로드 실패 ${items[i].title ?? guid}: ${err}`);
			}
			setStatus('syncing', `다운로드 중... (${i + 1}/${toDownloadSelected.length})`);
			emitProgress('download', '다운로드', items);
		}

		const doneCount = items.filter((i) => i.status === 'done').length;
		const errorCount = items.filter((i) => i.status === 'error').length;
		completedPhases.push({
			label: '다운로드',
			count: doneCount,
			errors: errorCount,
			items: items.map((i) => ({ ...i }))
		});
	}

	// ── Handle conflicts (sequential) ────────────────────────────────────────
	if (plan.conflicts.length > 0) {
		const items: SyncProgressItem[] = plan.conflicts.map((c) => ({
			guid: c.guid,
			title: c.title,
			status: 'pending' as SyncItemStatus
		}));
		emitProgress('conflict', '충돌 해결', items);

		for (let i = 0; i < plan.conflicts.length; i++) {
			const conflict = plan.conflicts[i];
			const explicitChoice = sel.conflictChoice.get(conflict.guid);
			const rev = serverNoteMap.get(conflict.guid) ?? 0;
			items[i].status = 'active';
			emitProgress('conflict', '충돌 해결', items);

			try {
				const content = await downloadNoteAtRevision(conflict.guid, rev, (attempt, waitMs) => {
					items[i].status = 'retrying';
					items[i].retryAttempt = attempt;
					items[i].retryWaitSec = Math.ceil(waitMs / 1000);
					emitProgress('conflict', '충돌 해결', items);
				});
				const remoteNote = parseNoteFromFile(content, `${conflict.guid}.note`);
				const local = localByGuid.get(conflict.guid);

				let useRemote: boolean;
				if (explicitChoice === 'remote') {
					useRemote = true;
				} else if (explicitChoice === 'local') {
					useRemote = false;
				} else {
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
					sel.upload.add(conflict.guid);
				}
				items[i].status = 'done';
			} catch (err) {
				items[i].status = 'error';
				items[i].error = String(err);
				result.errors.push(`충돌 해결 실패 ${items[i].title ?? conflict.guid}: ${err}`);
			}
			emitProgress('conflict', '충돌 해결', items);
		}

		const doneCount = items.filter((i) => i.status === 'done').length;
		const errorCount = items.filter((i) => i.status === 'error').length;
		completedPhases.push({
			label: '충돌 해결',
			count: doneCount,
			errors: errorCount,
			items: items.map((i) => ({ ...i }))
		});
	}

	// Save checkpoint after downloads
	await saveManifest(localManifest);

	// ── Delete locally (server-removed notes) ───────────────────────────────
	const toDeleteLocalSelected = plan.toDeleteLocal.filter((x) => sel.deleteLocal.has(x.guid));
	if (toDeleteLocalSelected.length > 0) {
		const items: SyncProgressItem[] = toDeleteLocalSelected.map((x) => ({
			guid: x.guid,
			title: x.title,
			status: 'pending' as SyncItemStatus
		}));
		emitProgress('delete-local', '로컬 삭제', items);

		for (let i = 0; i < toDeleteLocalSelected.length; i++) {
			const item = toDeleteLocalSelected[i];
			items[i].status = 'active';
			emitProgress('delete-local', '로컬 삭제', items);

			const local = localByGuid.get(item.guid);
			if (local && !local.localDirty) {
				await noteStore.purgeNote(item.guid);
				delete localManifest.noteRevisions[item.guid];
				result.deleted++;
			}
			items[i].status = 'done';
			emitProgress('delete-local', '로컬 삭제', items);
		}

		completedPhases.push({
			label: '로컬 삭제',
			count: toDeleteLocalSelected.length,
			errors: 0,
			items: items.map((i) => ({ ...i }))
		});
	}

	// ── Upload local changes ─────────────────────────────────────────────────
	const toUploadItems: Array<{ guid: string; content: string; note: NoteData }> = [];
	const toDeleteItems: string[] = [];

	const deleteRemoteSelected = plan.toDeleteRemote.filter((x) => sel.deleteRemote.has(x.guid));
	if (deleteRemoteSelected.length > 0) {
		const items: SyncProgressItem[] = deleteRemoteSelected.map((x) => ({
			guid: x.guid,
			title: x.title,
			status: 'done' as SyncItemStatus
		}));
		for (const item of deleteRemoteSelected) {
			if (serverNoteMap.has(item.guid)) toDeleteItems.push(item.guid);
			await noteStore.purgeNote(item.guid);
			delete localManifest.noteRevisions[item.guid];
			result.deleted++;
		}
		completedPhases.push({
			label: '서버 삭제',
			count: deleteRemoteSelected.length,
			errors: 0,
			items
		});
		emitProgress('upload', '업로드 준비 중...', []);
	}

	for (const item of plan.toUpload) {
		if (!sel.upload.has(item.guid)) continue;
		const local = localByGuid.get(item.guid);
		if (!local || processedGuids.has(item.guid)) continue;
		toUploadItems.push({ guid: item.guid, content: serializeNote(local), note: local });
	}

	// Also upload conflict-local-wins notes
	for (const conflict of plan.conflicts) {
		if (processedGuids.has(conflict.guid)) continue;
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
			const uploadProgressItems: SyncProgressItem[] = toUploadItems.map((x) => ({
				guid: x.guid,
				title: x.note.title,
				status: 'pending' as SyncItemStatus
			}));
			emitProgress('upload', '업로드', uploadProgressItems);
			setStatus('syncing', `업로드 중... (0/${toUploadItems.length})`);

			try {
				await commitRevision(
					newRev,
					toUploadItems.map(({ guid, content }) => ({ guid, content })),
					toDeleteItems,
					serverManifest,
					{
						onUploadStart: (guid) => {
							const item = uploadProgressItems.find((i) => i.guid === guid);
							if (item) item.status = 'active';
							emitProgress('upload', '업로드', uploadProgressItems);
						},
						onUploadDone: (guid) => {
							const item = uploadProgressItems.find((i) => i.guid === guid);
							if (item) item.status = 'done';
							const done = uploadProgressItems.filter((i) => i.status === 'done').length;
							setStatus('syncing', `업로드 중... (${done}/${uploadProgressItems.length})`);
							emitProgress('upload', '업로드', uploadProgressItems);
						},
						onUploadRetry: (guid, attempt, waitMs) => {
							const item = uploadProgressItems.find((i) => i.guid === guid);
							if (item) {
								item.status = 'retrying';
								item.retryAttempt = attempt;
								item.retryWaitSec = Math.ceil(waitMs / 1000);
							}
							emitProgress('upload', '업로드', uploadProgressItems);
						},
						onUploadError: (guid, error) => {
							const item = uploadProgressItems.find((i) => i.guid === guid);
							if (item) {
								item.status = 'error';
								item.error = String(error);
							}
							emitProgress('upload', '업로드', uploadProgressItems);
						}
					}
				);
			} catch (err) {
				result.errors.push(`업로드 커밋 실패: ${err}`);
				const doneCount = uploadProgressItems.filter((i) => i.status === 'done').length;
				const errorCount = uploadProgressItems.filter((i) => i.status === 'error').length;
				completedPhases.push({
					label: '업로드',
					count: doneCount,
					errors: errorCount,
					items: uploadProgressItems.map((i) => ({ ...i }))
				});
				emitProgress('done', '완료', []);

				result.status = 'error';
				localManifest.lastSyncDate = new Date().toISOString();
				await saveManifest(localManifest);
				setStatus('error');
				return result;
			}

			const doneCount = uploadProgressItems.filter((i) => i.status === 'done').length;
			completedPhases.push({
				label: '업로드',
				count: doneCount,
				errors: 0,
				items: uploadProgressItems.map((i) => ({ ...i }))
			});
		} else {
			// delete-only commit (no note uploads)
			try {
				await commitRevision(newRev, [], toDeleteItems, serverManifest);
			} catch (err) {
				result.errors.push(`삭제 커밋 실패: ${err}`);
				result.status = 'error';
				localManifest.lastSyncDate = new Date().toISOString();
				await saveManifest(localManifest);
				setStatus('error');
				emitProgress('done', '완료', []);
				return result;
			}
		}

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
		try {
			await refreshNotebooksCache();
		} catch {
			/* non-fatal */
		}
	}

	setStatus(result.status === 'success' ? 'success' : 'error');
	emitProgress('done', '완료', []);
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
