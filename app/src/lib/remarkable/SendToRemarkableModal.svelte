<script lang="ts">
	import { onMount } from 'svelte';
	import type { NoteData } from '$lib/core/note.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { getAllRemarkableSendDefaults } from '$lib/storage/appSettings.js';
	import {
		sendNoteToRemarkable,
		SendRemarkableError,
		type SendRemarkableStatus
	} from './sendNoteToRemarkable.js';
	import { previewPdfBundle } from './pdf/pdfBundle.js';
	import { pushToast } from '$lib/stores/toast.js';

	interface Props {
		rootGuid: string;
		onclose: () => void;
	}

	let { rootGuid, onclose }: Props = $props();

	let depth = $state(1);
	let alias = $state('');
	let folderName = $state('');
	let folderUuid = $state('');
	let prefillReady = $state(false);
	let sending = $state(false);
	let statusText = $state('');
	let errorText = $state('');
	let allNotes = $state<NoteData[]>([]);
	const ac = new AbortController();

	const canSend = $derived(
		!sending && alias !== '' && folderUuid !== '' && folderName !== ''
	);

	// depth 변경 시 어떤 노트들이 포함될지 실시간 계산 — 사용자가 depth 를 정하기
	// 더 쉽도록. allNotes 가 비어 있는 초기 한 프레임에는 빈 배열 반환.
	const preview = $derived(
		allNotes.length === 0
			? { includedGuids: [] as string[], titles: [] as string[] }
			: previewPdfBundle(rootGuid, allNotes, { depth })
	);

	onMount(async () => {
		const all = await getAllRemarkableSendDefaults();
		const first = Object.entries(all)[0];
		if (first) {
			alias = first[0];
			folderName = first[1].folderName;
			folderUuid = first[1].folderUuid;
		}
		allNotes = await getAllNotes();
		prefillReady = true;
	});

	function setStatus(s: SendRemarkableStatus): void {
		switch (s.step) {
			case 'building_pdf':
				statusText = 'PDF 만드는 중…';
				break;
			case 'uploading':
				statusText = `브릿지로 전송 중${s.message ? ` (${s.message})` : '…'}`;
				break;
			case 'folder_lookup':
				statusText = '리마커블 폴더 확인 중…';
				break;
			case 'ssh_write':
				statusText = '리마커블에 파일 쓰는 중…';
				break;
			case 'xochitl_reload':
				statusText = 'xochitl 재시작 중…';
				break;
		}
	}

	async function handleSend(): Promise<void> {
		if (!canSend) return;
		sending = true;
		errorText = '';
		statusText = '';
		try {
			const result = await sendNoteToRemarkable({
				rootGuid,
				notes: allNotes,
				alias: alias.trim(),
				folderName,
				folderUuid,
				depth,
				signal: ac.signal,
				onStatus: setStatus
			});
			const count = result.includedGuids.length;
			pushToast(
				count === 1
					? `리마커블 송출 완료 — ${result.visibleName}`
					: `리마커블 송출 완료 — ${result.visibleName} 외 ${count - 1}개 노트 포함`
			);
			onclose();
		} catch (err) {
			if (err instanceof SendRemarkableError) {
				errorText = describeError(err);
			} else {
				errorText = `알 수 없는 오류: ${(err as Error).message}`;
			}
			statusText = '';
		} finally {
			sending = false;
		}
	}

	function describeError(err: SendRemarkableError): string {
		switch (err.kind) {
			case 'not_configured':
				return err.detail ?? '브릿지/폴더 설정이 필요합니다 (설정 → 리마커블)';
			case 'unauthorized':
				return '브릿지 인증 실패 — 토큰을 다시 발급하세요';
			case 'unknown_alias':
				return `브릿지에 별칭 '${alias.trim()}' 가 등록되어 있지 않습니다`;
			case 'unknown_folder':
				return err.detail ?? '리마커블에서 지정한 폴더를 찾을 수 없습니다';
			case 'remote_failure':
				return err.detail ? `리마커블 접속 실패: ${err.detail}` : '리마커블 접속 실패';
			case 'network':
				return err.detail === 'aborted' ? '중단되었습니다' : `네트워크 오류: ${err.detail ?? ''}`;
			case 'internal':
				return `내부 오류: ${err.detail ?? '알 수 없음'}`;
		}
	}

	function cancel(): void {
		if (sending) {
			ac.abort();
			return;
		}
		onclose();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') cancel();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rm-modal-backdrop" onclick={() => !sending && onclose()}></div>
<div class="rm-modal" role="dialog" aria-modal="true" aria-label="리마커블로 보내기">
	<header class="rm-header">
		<h2>리마커블로 보내기</h2>
	</header>
	<div class="rm-body">
		<label class="rm-row">
			<span class="rm-label">링크 깊이</span>
			<select class="rm-input" bind:value={depth} disabled={sending}>
				<option value={0}>0 — 이 노트만</option>
				<option value={1}>1 — 직접 링크된 노트까지</option>
				<option value={2}>2 — 손자 노트까지</option>
				<option value={3}>3 — 증손자 노트까지</option>
				<option value={4}>4 — 4촌 노트까지</option>
				<option value={5}>5 — 5촌 노트까지</option>
			</select>
		</label>

		<div class="rm-row">
			<span class="rm-label">대상</span>
			<span class="rm-readonly">
				{#if folderName && alias}
					{alias} <span class="rm-sep">/</span> {folderName}
				{:else if prefillReady}
					미설정 — 설정 → 리마커블 탭에서 폴더를 지정하세요
				{:else}
					…
				{/if}
			</span>
		</div>

		{#if prefillReady}
			<div class="rm-row">
				<span class="rm-label">포함될 노트 ({preview.includedGuids.length}개)</span>
				<div class="rm-preview">
					{#if preview.titles.length === 0}
						<span class="rm-preview-empty">노트를 찾을 수 없습니다</span>
					{:else}
						<ol class="rm-preview-list">
							{#each preview.titles as t, i (preview.includedGuids[i])}
								<li>{t}</li>
							{/each}
						</ol>
					{/if}
				</div>
			</div>
		{/if}

		{#if statusText}
			<p class="rm-status">{statusText}</p>
		{/if}
		{#if errorText}
			<p class="rm-error">{errorText}</p>
		{/if}
	</div>
	<footer class="rm-footer">
		<button class="btn" onclick={cancel} type="button">
			{sending ? '중단' : '취소'}
		</button>
		<button class="btn btn-primary" onclick={handleSend} disabled={!canSend} type="button">
			{sending ? '전송 중…' : '보내기'}
		</button>
	</footer>
</div>

<style>
	.rm-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		/* 이 모달은 NoteWindow(.note-window) 안에 마운트되어 그 stacking context 에
		   갇히므로, 실제로는 같은 창 안의 콘텐츠 위로만 뜬다(데스크탑 밴드를 못 넘는다).
		   따라서 창-내부 기준의 모달 tier 면 충분하다. 창 밖으로 띄우려면 use:portal 필요.
		   CLAUDE.md "z-index 레이어 규약". */
		z-index: var(--z-modal);
	}
	.rm-modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: var(--z-modal);
		background: #fff;
		color: #111;
		border-radius: 8px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
		width: min(420px, calc(100vw - 32px));
		max-height: calc(100vh - 64px);
		display: flex;
		flex-direction: column;
		font-size: 0.92rem;
	}
	.rm-header {
		padding: 14px 18px 6px;
	}
	.rm-header h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.rm-body {
		padding: 8px 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.rm-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.rm-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: #444;
	}
	.rm-input {
		padding: 6px 8px;
		border: 1px solid #ccc;
		border-radius: 4px;
		font: inherit;
		background: #fff;
		color: #111;
	}
	.rm-readonly {
		padding: 6px 8px;
		border: 1px dashed #ddd;
		border-radius: 4px;
		color: #555;
		background: #fafafa;
	}
	.rm-sep {
		color: #aaa;
		margin: 0 2px;
	}
	.rm-preview {
		max-height: 180px;
		overflow-y: auto;
		border: 1px solid #e4e8ec;
		border-radius: 4px;
		background: #fafafa;
		padding: 6px 4px;
	}
	.rm-preview-list {
		margin: 0;
		padding-left: 24px;
		font-size: 0.85rem;
		color: #333;
	}
	.rm-preview-list li {
		padding: 1px 0;
	}
	.rm-preview-empty {
		display: block;
		padding: 4px 8px;
		color: #888;
		font-size: 0.85rem;
	}
	.rm-status {
		margin: 0;
		color: #2a6;
		font-size: 0.88rem;
	}
	.rm-error {
		margin: 0;
		color: #c44;
		font-size: 0.88rem;
	}
	.rm-footer {
		padding: 10px 18px 16px;
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.btn {
		padding: 6px 14px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #f4f4f4;
		cursor: pointer;
		color: #111;
		font: inherit;
	}
	.btn-primary {
		background: #2a6;
		color: #fff;
		border-color: #2a6;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
