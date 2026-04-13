<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		downloadServerManifest,
		downloadNoteAtRevision,
		downloadFileText,
		listRevisions,
		downloadRevisionManifest,
		rootManifestFullPath,
		revisionManifestFullPath
	} from '$lib/sync/dropboxClient.js';
	import {
		getAllNotesIncludingDeleted,
		purgeAllLocal,
		putNote
	} from '$lib/storage/noteStore.js';
	import { serializeNote, parseNoteFromFile } from '$lib/core/noteArchiver.js';
	import { createEmptyNote } from '$lib/core/note.js';
	import type { NoteData } from '$lib/core/note.js';
	import { getManifest, clearManifest } from '$lib/sync/manifest.js';
	import { invalidateCache } from '$lib/stores/noteListCache.js';
	import { pushToast } from '$lib/stores/toast.js';
	import JSZip from 'jszip';

	let authed = $state(false);
	let running = $state(false);
	let progress = $state('');

	onMount(() => {
		authed = isAuthenticated();
	});

	/**
	 * Zip up the local IndexedDB notes and download. Much faster than round-
	 * tripping through Dropbox — and captures local-dirty notes that haven't
	 * been synced yet. The produced archive is a superset of what's on the
	 * server at the last sync, plus any pending local changes.
	 */
	async function backupLocal() {
		if (running) return;
		running = true;
		progress = '로컬 노트 수집 중...';
		try {
			const allNotes = await getAllNotesIncludingDeleted();
			const live = allNotes.filter((n) => !n.deleted);
			const tombstones = allNotes.filter((n) => n.deleted);
			const localManifest = await getManifest();

			const zip = new JSZip();
			const notesDir = zip.folder('notes')!;
			for (const n of live) {
				notesDir.file(`${n.guid}.note`, serializeNote(n));
			}
			if (tombstones.length > 0) {
				zip.file(
					'tombstones.txt',
					tombstones.map((n) => `${n.guid}\t${n.title}`).join('\n')
				);
			}
			zip.file('local-manifest.json', JSON.stringify(localManifest, null, 2));
			zip.file(
				'meta.txt',
				[
					`Tomboy Web — 로컬 백업`,
					`생성: ${new Date().toISOString()}`,
					`노트 수: ${live.length}`,
					`삭제 보류(툼스톤): ${tombstones.length}`,
					`마지막 동기화 rev: ${localManifest.lastSyncRev}`,
					`마지막 동기화 시각: ${localManifest.lastSyncDate || '(없음)'}`,
					`server-id: ${localManifest.serverId || '(없음)'}`
				].join('\n')
			);

			progress = 'zip 생성 중...';
			const blob = await zip.generateAsync({ type: 'blob' });
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			downloadBlob(blob, `tomboy-local-backup-${ts}.zip`);
			pushToast(`로컬 백업 완료: ${live.length}개 노트`);
		} catch (e) {
			pushToast('백업 실패: ' + String(e), { kind: 'error' });
		} finally {
			running = false;
			progress = '';
		}
	}

	/**
	 * Download every revision that still exists on the server. Produces a
	 * larger archive but preserves full history.
	 */
	async function backupFullHistory() {
		if (running) return;
		running = true;
		progress = '리비전 목록 수집 중...';
		try {
			const revs = await listRevisions();
			if (revs.length === 0) throw new Error('리비전이 없습니다');

			const zip = new JSZip();
			const currentManifest = await downloadServerManifest();
			if (currentManifest) {
				zip.file('manifest.xml', await downloadFileText(rootManifestFullPath()));
				zip.file('server-id.txt', currentManifest.serverId);
			}

			let r = 0;
			const seenNoteFiles = new Set<string>();
			for (const rev of revs) {
				r++;
				progress = `리비전 ${rev} (${r}/${revs.length})...`;
				const m = await downloadRevisionManifest(rev);
				if (!m) continue;
				const revDir = zip.folder(`rev-${rev}`)!;
				revDir.file(
					'manifest.xml',
					await downloadFileText(revisionManifestFullPath(rev)).catch(() => '')
				);
				for (const n of m.notes) {
					const key = `${n.guid}@${n.rev}`;
					if (seenNoteFiles.has(key)) continue;
					seenNoteFiles.add(key);
					try {
						const content = await downloadNoteAtRevision(n.guid, n.rev);
						// Store note files keyed by their actual rev to avoid duplication
						zip.folder('notes-by-rev')!.file(`${n.guid}.rev${n.rev}.note`, content);
					} catch {
						// skip missing file
					}
				}
			}

			progress = 'zip 생성 중...';
			const blob = await zip.generateAsync({ type: 'blob' });
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			downloadBlob(blob, `tomboy-full-history-${ts}.zip`);
			pushToast(`전체 히스토리 백업 완료: ${revs.length}개 리비전`);
		} catch (e) {
			pushToast('백업 실패: ' + String(e), { kind: 'error' });
		} finally {
			running = false;
			progress = '';
		}
	}

	/**
	 * Restore the local IndexedDB from a previously created local-backup zip.
	 * This is a reset: existing notes are wiped first, then the zip's notes,
	 * tombstones are imported. The sync manifest is cleared so the next sync
	 * treats everything as local (all restored notes are marked localDirty).
	 */
	let fileInput: HTMLInputElement | undefined = $state(undefined);

	async function restoreLocalFromZip(file: File) {
		if (running) return;
		running = true;
		progress = 'zip 파일 읽는 중...';
		try {
			const zip = await JSZip.loadAsync(file);

			// Collect .note files under notes/ (or anywhere named guid.note).
			const noteEntries: Array<{ basename: string; file: JSZip.JSZipObject }> = [];
			zip.forEach((relPath, entry) => {
				if (entry.dir) return;
				if (!relPath.toLowerCase().endsWith('.note')) return;
				const basename = relPath.split('/').pop() ?? relPath;
				noteEntries.push({ basename, file: entry });
			});

			// Read optional tombstones.txt.
			const tombstonesFile = zip.file('tombstones.txt');
			let tombstoneLines: string[] = [];
			if (tombstonesFile) {
				const raw = await tombstonesFile.async('text');
				tombstoneLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
			}

			if (noteEntries.length === 0 && tombstoneLines.length === 0) {
				throw new Error('zip 안에 복원할 .note 파일이 없습니다.');
			}

			const ok = window.confirm(
				`기존에 저장된 노트가 모두 삭제되고 zip 내용으로 교체됩니다.\n` +
					`- 복원할 노트: ${noteEntries.length}개\n` +
					`- 툼스톤: ${tombstoneLines.length}개\n\n` +
					`계속하시겠습니까?`
			);
			if (!ok) {
				progress = '';
				return;
			}

			progress = '기존 로컬 상태 삭제 중...';
			await purgeAllLocal();
			await clearManifest();

			progress = `노트 복원 중 (0/${noteEntries.length})...`;
			let imported = 0;
			let failed = 0;
			let i = 0;
			for (const { basename, file: entry } of noteEntries) {
				i++;
				if (i % 20 === 0) progress = `노트 복원 중 (${i}/${noteEntries.length})...`;
				try {
					const xml = await entry.async('text');
					const note = parseNoteFromFile(xml, basename);
					await putNote(note);
					imported++;
				} catch {
					failed++;
				}
			}

			let restoredTombstones = 0;
			if (tombstoneLines.length > 0) {
				progress = '툼스톤 복원 중...';
				for (const line of tombstoneLines) {
					const [guid, ...titleParts] = line.split('\t');
					if (!guid) continue;
					const title = titleParts.join('\t');
					const base = createEmptyNote(guid);
					const tomb: NoteData = {
						...base,
						title: title || base.title,
						deleted: true
					};
					try {
						await putNote(tomb);
						restoredTombstones++;
					} catch {
						/* skip */
					}
				}
			}

			invalidateCache();

			const msg = `복원 완료: 노트 ${imported}개${
				failed > 0 ? ` (실패 ${failed}개)` : ''
			}${restoredTombstones > 0 ? `, 툼스톤 ${restoredTombstones}개` : ''}`;
			pushToast(msg, { kind: failed > 0 ? 'error' : 'info' });
		} catch (e) {
			pushToast('복원 실패: ' + String(e), { kind: 'error' });
		} finally {
			running = false;
			progress = '';
			if (fileInput) fileInput.value = '';
		}
	}

	function onRestoreFileChosen(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		void restoreLocalFromZip(file);
	}

	function triggerRestore() {
		fileInput?.click();
	}

	function downloadBlob(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

<h2 class="page-title">도구</h2>

<section class="tool danger">
	<h3>zip으로 로컬 초기화 · 복원</h3>
	<p class="info">
		로컬 상태 백업(zip)을 선택하면 <strong>현재 IndexedDB의 모든 노트가 삭제되고</strong>
		zip 내용으로 교체됩니다. 초기화 전에는 반드시 먼저 백업을 받아두세요.
		복원된 노트는 모두 "로컬 변경" 상태가 되어 다음 동기화 시 서버로 업로드됩니다.
	</p>
	<button class="btn btn-danger" onclick={triggerRestore} disabled={running}>
		{running ? '진행 중...' : 'zip 파일 선택해서 복원'}
	</button>
	<input
		bind:this={fileInput}
		type="file"
		accept=".zip,application/zip"
		onchange={onRestoreFileChosen}
		hidden
	/>
</section>

{#if !authed}
	<div class="notice">Dropbox 백업 도구를 사용하려면 Dropbox 연결이 필요합니다.</div>
{:else}
	<section class="tool">
		<h3>로컬 상태 백업 (zip)</h3>
		<p class="info">
			브라우저의 IndexedDB에 저장된 모든 노트(로컬 변경사항 포함)를 zip으로 다운로드합니다.
			서버를 거치지 않아 빠르며, 아직 동기화되지 않은 로컬 수정도 그대로 포함됩니다.
			롤백이나 초기화 전 안전망으로 사용하세요.
		</p>
		<button class="btn" onclick={backupLocal} disabled={running}>
			{running ? '진행 중...' : '로컬 상태 zip 다운로드'}
		</button>
	</section>

	<section class="tool">
		<h3>전체 히스토리 백업 (zip)</h3>
		<p class="info">
			서버에 남아있는 <strong>모든 리비전</strong>의 매니페스트와 노트 파일을 zip으로 묶어 내려받습니다.
			리비전이 많으면 시간이 오래 걸립니다.
		</p>
		<button class="btn" onclick={backupFullHistory} disabled={running}>
			{running ? '진행 중...' : '전체 히스토리 zip 다운로드'}
		</button>
	</section>
{/if}

{#if progress}
	<div class="progress">{progress}</div>
{/if}

<style>
	.page-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 16px; }
	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.tool {
		padding: 16px;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 10px;
		margin-bottom: 16px;
		background: var(--color-bg, #fff);
	}
	.tool h3 { margin: 0 0 6px; font-size: 0.95rem; font-weight: 600; }
	.info {
		margin: 0 0 12px;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		line-height: 1.5;
	}
	.btn {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 10px 16px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 500;
	}
	.btn:disabled { opacity: 0.6; cursor: not-allowed; }
	.btn-danger { background: #dc2626; }
	.tool.danger { border-color: #fca5a5; background: #fff6f6; }
	.progress {
		margin-top: 16px;
		padding: 10px 14px;
		background: #eff6ff;
		border: 1px solid #bfdbfe;
		border-radius: 6px;
		font-size: 0.85rem;
		color: #1e40af;
	}
</style>
