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
	import { pushToast } from '$lib/stores/toast.js';
	import JSZip from 'jszip';

	let authed = $state(false);
	let running = $state(false);
	let progress = $state('');

	onMount(() => {
		authed = isAuthenticated();
	});

	/**
	 * Download the current server state (root manifest + all notes at their
	 * tracked revs) into a zip. This is a *snapshot of the current manifest*,
	 * not the full revision history.
	 */
	async function backupCurrent() {
		if (running) return;
		running = true;
		progress = '매니페스트 불러오는 중...';
		try {
			const manifest = await downloadServerManifest();
			if (!manifest) throw new Error('서버에 매니페스트가 없습니다');

			const zip = new JSZip();
			const manifestXml = await downloadFileText(rootManifestFullPath());
			zip.file('manifest.xml', manifestXml);
			zip.file('revision.txt', String(manifest.revision));
			zip.file('server-id.txt', manifest.serverId);

			const notesDir = zip.folder('notes')!;
			let i = 0;
			for (const { guid, rev } of manifest.notes) {
				i++;
				progress = `노트 다운로드 중 ${i}/${manifest.notes.length}...`;
				try {
					const content = await downloadNoteAtRevision(guid, rev);
					notesDir.file(`${guid}.note`, content);
				} catch (e) {
					notesDir.file(
						`${guid}.error.txt`,
						`Failed to download ${guid} at rev ${rev}:\n${String(e)}`
					);
				}
			}

			progress = 'zip 생성 중...';
			const blob = await zip.generateAsync({ type: 'blob' });
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			downloadBlob(blob, `tomboy-backup-rev${manifest.revision}-${ts}.zip`);
			pushToast(`백업 완료: ${manifest.notes.length}개 노트`);
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
						zip
							.folder('notes-by-rev')!
							.file(`${n.guid}.rev${n.rev}.note`, content);
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
		<h3>현재 상태 백업 (zip)</h3>
		<p class="info">
			현재 root manifest와 그에 나열된 모든 노트 파일을 zip으로 다운로드합니다.
			소프트 롤백이나 서버 초기화 전에 안전망으로 사용하세요.
		</p>
		<button class="btn" onclick={backupCurrent} disabled={running}>
			{running ? '진행 중...' : '현재 상태 zip 다운로드'}
		</button>
	</section>

	<section class="tool">
		<h3>전체 히스토리 백업 (zip)</h3>
		<p class="info">
			서버에 남아있는 <strong>모든 리비전</strong>의 매니페스트와 노트 파일을 zip으로 묶어 내려받습니다.
			리비전이 많으면 시간이 오래 걸릴 수 있습니다.
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
