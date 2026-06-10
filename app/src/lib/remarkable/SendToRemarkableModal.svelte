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
	import { previewPdfBundle, type PdfBundleTreeNode } from './pdf/pdfBundle.js';
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
	let excludedGuids = $state(new Set<string>());
	const ac = new AbortController();

	const canSend = $derived(
		!sending && alias !== '' && folderUuid !== '' && folderName !== ''
	);

	// depth / excludedGuids 변경 시 트리 + 포함 guid 실시간 재계산.
	const preview = $derived(
		allNotes.length === 0
			? { tree: null, includedGuids: [] as string[], titles: new Map<string, string>() }
			: previewPdfBundle(rootGuid, allNotes, { depth, excludedGuids })
	);

	// 제외 목록은 사용자가 명시적으로 끈 guid 만. 제외된 guid 의 표시명은 노트
	// 자체에서 가져옴 (트리에는 더 이상 안 나타나므로).
	const excludedItems = $derived(
		[...excludedGuids]
			.filter((g) => g !== rootGuid)
			.map((g) => {
				const note = allNotes.find((n) => n.guid === g);
				return { guid: g, title: note?.title?.trim() || '제목 없음' };
			})
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

	function toggleGuid(guid: string): void {
		// 루트는 제외할 수 없다 — 루트가 빠지면 번들 전체가 빈다.
		if (guid === rootGuid) return;
		const next = new Set(excludedGuids);
		if (next.has(guid)) next.delete(guid);
		else next.add(guid);
		excludedGuids = next;
	}

	function restoreGuid(guid: string): void {
		const next = new Set(excludedGuids);
		next.delete(guid);
		excludedGuids = next;
	}

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
				excludedGuids,
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

{#snippet treeNode(node: PdfBundleTreeNode, isRoot: boolean)}
	<li class="rm-tree-item">
		<label class="rm-tree-label">
			<input
				type="checkbox"
				checked
				disabled={isRoot || sending}
				onchange={() => toggleGuid(node.guid)}
			/>
			<span class="rm-tree-title">{node.title}</span>
			{#if isRoot}
				<span class="rm-tree-root-tag">루트</span>
			{/if}
		</label>
		{#if node.children.length > 0}
			<ul class="rm-tree-children">
				{#each node.children as child (child.positionKey)}
					{@render treeNode(child, false)}
				{/each}
			</ul>
		{/if}
	</li>
{/snippet}

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
				<div class="rm-tree-box">
					{#if preview.tree === null}
						<span class="rm-tree-empty">노트를 찾을 수 없습니다</span>
					{:else}
						<ul class="rm-tree-root">
							{@render treeNode(preview.tree, true)}
						</ul>
					{/if}
				</div>
				<p class="rm-tree-hint">
					체크를 해제하면 트리에서 제거되고 그 노트로 향하는 링크는 본문에서 텍스트로만
					남습니다. 같은 노트가 여러 곳에 있어도 한 번 해제하면 전부 빠집니다.
				</p>
			</div>

			{#if excludedItems.length > 0}
				<div class="rm-row">
					<span class="rm-label">제외 목록 ({excludedItems.length}개)</span>
					<ul class="rm-excluded-box">
						{#each excludedItems as item (item.guid)}
							<li class="rm-excluded-item">
								<span class="rm-excluded-title">{item.title}</span>
								<button
									type="button"
									class="rm-restore"
									disabled={sending}
									onclick={() => restoreGuid(item.guid)}
								>
									복원
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
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
		/* Above pinned NoteWindow (1_000_000 + z) and SpreadOverlay (2_000_000). */
		z-index: 2500000;
	}
	.rm-modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 2500001;
		background: #fff;
		color: #111;
		border-radius: 8px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
		width: min(460px, calc(100vw - 32px));
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
		overflow-y: auto;
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
	.rm-tree-box {
		max-height: 220px;
		overflow-y: auto;
		border: 1px solid #e4e8ec;
		border-radius: 4px;
		background: #fafafa;
		padding: 6px 8px;
	}
	.rm-tree-empty {
		display: block;
		padding: 4px 8px;
		color: #888;
		font-size: 0.85rem;
	}
	.rm-tree-root,
	.rm-tree-children {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rm-tree-children {
		padding-left: 18px;
		border-left: 1px dashed #d0d4d8;
		margin-left: 6px;
	}
	.rm-tree-item {
		padding: 2px 0;
	}
	.rm-tree-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		font-size: 0.88rem;
		color: #222;
	}
	.rm-tree-label input[type='checkbox'] {
		margin: 0;
		cursor: pointer;
	}
	.rm-tree-label input[type='checkbox']:disabled {
		cursor: not-allowed;
	}
	.rm-tree-title {
		flex: 1;
	}
	.rm-tree-root-tag {
		font-size: 0.7rem;
		color: #1a6fc4;
		background: #e8f1fa;
		padding: 0 6px;
		border-radius: 3px;
	}
	.rm-tree-hint {
		margin: 4px 2px 0;
		font-size: 0.78rem;
		color: #888;
		line-height: 1.35;
	}
	.rm-excluded-box {
		list-style: none;
		margin: 0;
		padding: 4px 6px;
		border: 1px solid #f3d6d6;
		background: #fdf3f3;
		border-radius: 4px;
		max-height: 140px;
		overflow-y: auto;
	}
	.rm-excluded-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 2px 4px;
		font-size: 0.85rem;
		color: #863131;
	}
	.rm-excluded-title {
		text-decoration: line-through;
		text-decoration-color: #c98a8a;
		opacity: 0.85;
	}
	.rm-restore {
		font: inherit;
		font-size: 0.78rem;
		padding: 2px 8px;
		border: 1px solid #c98a8a;
		background: #fff;
		color: #863131;
		border-radius: 3px;
		cursor: pointer;
	}
	.rm-restore:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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
