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
	import { getAllNotesIncludingDeleted } from '$lib/storage/noteStore.js';
	import { serializeNote } from '$lib/core/noteArchiver.js';
	import { getManifest } from '$lib/sync/manifest.js';
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

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
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

	{#if progress}
		<div class="progress">{progress}</div>
	{/if}
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
